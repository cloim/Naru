import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA, DISTRO, atomicJSON } from './state.js';
import { wsl, command, distributions, MAINTENANCE_FILE } from './runner.js';
import * as runtime from './runtime.js';

const VHDX = path.join(DATA, 'wsl', 'ext4.vhdx');
const WORK = path.join(DATA, 'maintenance');
const GB = 1024 ** 3;
// 이보다 적게 돌려받는다면 엔진을 멈출 가치가 없다.
export const MIN_RECLAIM = GB;
const UAC_TIMEOUT_MS = 120000,
  COMPACT_TIMEOUT_MS = 3600000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gb = (bytes) => `${(bytes / GB).toFixed(1)}GB`;

// 가상 디스크 파일 크기와 그 안의 실제 사용량. 사용량은 엔진이 켜져 있을 때만 잴 수 있다.
export async function diskUsage() {
  const file = (await fs.stat(VHDX)).size;
  if (!(await distributions(true)).includes(DISTRO)) return { file, used: null, reclaimable: null };
  const [, used] = (await wsl(['df', '-k', '/'])).split('\n')[1].trim().split(/\s+/).slice(1, 3);
  const usedBytes = Number(used) * 1024;
  return { file, used: usedBytes, reclaimable: Math.max(0, file - usedBytes) };
}

// 배포판이 디스크를 놓았는지 확인한다. 연결된 동안에는 쓰기 모드로 열 때 EBUSY가 난다.
async function released(waitMs) {
  for (const until = Date.now() + waitMs; ; await sleep(1000)) {
    try {
      await (await fs.open(VHDX, 'r+')).close();
      return true;
    } catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      if (Date.now() > until) return false;
    }
  }
}

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

// diskpart는 관리자 권한이 필요하다. UAC 승인 뒤 실행되는 배치가 시작 표시를 남기고,
// 승인이 늦으면 스크립트를 지워 나중에 승인되더라도 압축이 돌지 않게 한다.
async function elevatedCompact(log) {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const script = path.join(WORK, 'compact.txt'),
    batch = path.join(WORK, 'compact.cmd'),
    started = path.join(WORK, 'started'),
    done = path.join(WORK, 'done'),
    output = path.join(WORK, 'diskpart.log');
  await fs.writeFile(
    script,
    `select vdisk file="${VHDX}"\r\nattach vdisk readonly\r\ncompact vdisk\r\ndetach vdisk\r\n`,
  );
  await fs.writeFile(
    batch,
    [
      '@echo off',
      'chcp 65001 >nul',
      `if not exist "${script}" exit /b 1`,
      `echo started> "${started}"`,
      `diskpart /s "${script}" > "${output}" 2>&1`,
      `echo %errorlevel%> "${done}"`,
      '',
    ].join('\r\n'),
  );
  log('관리자 권한 승인 창(UAC)이 PC 화면에 뜹니다. 2분 안에 승인해 주세요.\n');
  await command('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process -FilePath cmd.exe -ArgumentList '/d','/c','"${batch}"' -Verb RunAs -WindowStyle Hidden`,
  ]).catch((e) => {
    throw new Error(`관리자 권한을 받지 못했습니다: ${e.message}`);
  });
  for (const until = Date.now() + UAC_TIMEOUT_MS; !(await exists(started)); await sleep(1000))
    if (Date.now() > until) {
      await fs.rm(script, { force: true });
      // 지우기 직전에 승인되어 이미 시작했다면 끝까지 기다린다.
      await sleep(2000);
      if (!(await exists(started))) throw new Error('관리자 권한 승인 시간이 지났습니다.');
    }
  log('압축을 시작했습니다. 디스크 크기에 따라 몇 분 걸립니다.\n');
  for (const until = Date.now() + COMPACT_TIMEOUT_MS; !(await exists(done)); await sleep(2000))
    if (Date.now() > until)
      throw Object.assign(
        new Error(
          '압축 제한 시간을 넘었습니다. diskpart가 끝난 뒤 설정에서 엔진을 직접 시작해 주세요.',
        ),
        { diskBusy: true },
      );
  const code = (await fs.readFile(done, 'utf8')).trim();
  log((await fs.readFile(output, 'utf8').catch(() => '')).trim() + '\n');
  if (code !== '0') throw new Error(`diskpart가 실패했습니다 (종료 코드 ${code}).`);
}

export async function compactDisk(log) {
  const before = await diskUsage();
  if (before.used === null) throw new Error('엔진을 켠 상태에서 압축해 주세요.');
  if (before.reclaimable < MIN_RECLAIM)
    throw new Error(`돌려받을 공간이 ${gb(before.reclaimable)}뿐이라 압축하지 않습니다.`);
  log(`디스크 파일 ${gb(before.file)}, 사용 ${gb(before.used)}\n`);
  log((await wsl(['fstrim', '-v', '/'], { timeout: 600000 })) + '\n');
  // 이 표시가 있는 동안 서버는 배포판을 깨우지 않는다(runner.assertDistroAvailable).
  await atomicJSON(MAINTENANCE_FILE, { pid: process.pid, since: new Date().toISOString() });
  let diskBusy = false;
  try {
    await runtime.stop(log);
    if (!(await released(20000))) {
      log('Naru 배포판만 종료해서는 디스크가 풀리지 않아 WSL 전체를 종료합니다.\n');
      await command('wsl.exe', ['--shutdown'], { timeout: 60000 });
      if (!(await released(30000)))
        throw new Error('다른 프로세스가 디스크 파일을 쓰고 있어 압축하지 않았습니다.');
    }
    await elevatedCompact(log);
  } catch (e) {
    diskBusy = !!e.diskBusy;
    throw e;
  } finally {
    await fs.rm(MAINTENANCE_FILE, { force: true });
    // diskpart가 아직 디스크를 잡고 있으면 엔진을 켜지 않고, 작업 폴더도 로그 확인용으로 남긴다.
    if (!diskBusy) {
      await fs.rm(WORK, { recursive: true, force: true });
      log('엔진을 다시 시작합니다.\n');
      await runtime.start(log);
    }
  }
  const after = (await fs.stat(VHDX)).size;
  log(`압축 완료: ${gb(before.file)} → ${gb(after)} (${gb(before.file - after)} 회수)\n`);
}
