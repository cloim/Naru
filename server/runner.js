import { localOnly } from './engine-context.js';
import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { ROOT, DATA, DISTRO } from './state.js';

// 디스크 압축 중에는 배포판을 깨우면 안 된다. 압축 작업 프로세스만 배포판을 다룰 수 있다.
export const MAINTENANCE_FILE = path.join(DATA, 'maintenance.json');
export function assertDistroAvailable() {
  let pid;
  try {
    pid = JSON.parse(readFileSync(MAINTENANCE_FILE, 'utf8')).pid;
    process.kill(pid, 0);
  } catch {
    return;
  }
  if (pid !== process.pid)
    throw new Error('디스크를 압축하는 중입니다. 끝나면 엔진이 다시 시작됩니다.');
}

export function command(
  exe,
  args,
  {
    timeout = 30000,
    input,
    log,
    onOutput,
    onSpawn,
    encoding = 'utf8',
    combine = false,
    fullResult = false,
    maxBytes = 16 * 1024 * 1024,
    cwd = ROOT,
    env = {},
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env, ...env, WSL_UTF8: '1' },
    });
    onSpawn?.(child);
    const out = [],
      err = [];
    let bytes = 0,
      finished = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`명령 제한 시간 ${timeout / 1000}초 초과: ${path.basename(exe)}`));
    }, timeout);
    const finish = (e, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      e ? reject(e) : resolve(value);
    };
    child.on('error', finish);
    for (const [stream, buffers] of [
      [child.stdout, out],
      [child.stderr, err],
    ])
      stream.on('data', (data) => {
        bytes += data.length;
        if (bytes > maxBytes) {
          child.kill();
          finish(new Error('출력 크기 제한을 초과했습니다.'));
          return;
        }
        buffers.push(data);
        if (combine && buffers === err) out.push(data);
        log?.(data.toString(encoding));
        onOutput?.({ [buffers === err ? 'stderr' : 'stdout']: data.toString(encoding) });
      });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString(encoding).replace(/\0/g, '').trim();
      const stderr = Buffer.concat(err).toString(encoding).replace(/\0/g, '').trim();
      fullResult
        ? finish(null, { code, stdout, stderr })
        : code === 0
          ? finish(null, stdout)
          : finish(new Error(stderr || stdout || `명령 실패 (${code}): ${exe}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export async function wsl(args, options) {
  localOnly();
  assertDistroAvailable();
  return command(
    'wsl.exe',
    ['--distribution', DISTRO, '--user', 'root', '--exec', ...args],
    options,
  );
}
export async function distributions(running = false) {
  const text = await command('wsl.exe', ['--list', '--quiet', ...(running ? ['--running'] : [])], {
    timeout: 10000,
  });
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}
export async function detached(exe, args, { cwd = ROOT } = {}) {
  // Windows CommandLineToArgvW quoting. Never route user data through cmd.exe.
  const quote = (value) => {
    const s = String(value);
    return s && !/[\s"]/.test(s)
      ? s
      : '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  };
  const line = [exe, ...args].map(quote).join(' ');
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(ROOT, 'scripts', 'run-hidden.ps1'),
      '-EncodedLine',
      Buffer.from(line, 'utf8').toString('base64'),
      '-Directory',
      cwd,
    ],
    { windowsHide: true, timeout: 20000 },
  );
  return Number(stdout.trim());
}
