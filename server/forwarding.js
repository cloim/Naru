import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { DATA, ROOT, DISTRO, atomicJSON, readJSON } from './state.js';
import { wsl, detached, distributions } from './runner.js';
import { requireReady } from './runtime.js';
export async function listForwards() {
  const dir = path.join(DATA, 'forwards');
  await fs.mkdir(dir, { recursive: true });
  const rows = await Promise.all(
    (await fs.readdir(dir))
      .filter((x) => x.endsWith('.json'))
      .map((x) => readJSON(path.join(dir, x))),
  );
  const active = (await distributions(true)).includes(DISTRO);
  return Promise.all(
    rows.map(async (r) => {
      if (r.state !== 'running') return r;
      const alive = active && (await isForwardAlive(r));
      if (alive) return r;
      const value = { ...r, state: 'stopped' };
      await atomicJSON(path.join(dir, `${r.id}.json`), value);
      return value;
    }),
  );
}
export async function createForward(p, log) {
  await requireReady();
  // Reserve the host port as a preflight. Never seize another application's listener.
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(p.localPort, '127.0.0.1', () => s.close(resolve));
  });
  const text = await fs.readFile(path.join(ROOT, 'scripts', 'naru-forward.sh'), 'utf8');
  await wsl(
    ['sh', '-c', 'cat > /usr/local/bin/naru-forward; chmod 755 /usr/local/bin/naru-forward'],
    { input: text.replace(/\r/g, '') },
  );
  const id = crypto.randomUUID();
  const pid = await detached('wsl.exe', [
    '-d',
    DISTRO,
    '-u',
    'root',
    '--exec',
    '/usr/local/bin/naru-forward',
    id,
    p.namespace,
    p.resource,
    `${p.localPort}:${p.remotePort}`,
  ]);
  const meta = { id, ...p, pid, state: 'starting', createdAt: new Date().toISOString() };
  const file = path.join(DATA, 'forwards', `${id}.json`);
  await atomicJSON(file, meta);
  for (let i = 0; i < 30; i++) {
    const output = await wsl([
      'sh',
      '-c',
      `cat /var/log/naru/forward-${id}.log 2>/dev/null || true`,
    ]);
    if (output.includes('Forwarding from')) {
      const identity = await wsl([
        'sh',
        '-c',
        `pid=$(cat /run/naru/forwards/${id}.pid); printf '%s ' "$pid"; awk '{print $22}' /proc/$pid/stat`,
      ]);
      const [linuxPid, startTicks] = identity.split(' ');
      await atomicJSON(file, { ...meta, state: 'running', linuxPid: Number(linuxPid), startTicks });
      log(output);
      return;
    }
    if (/error:|Error/.test(output)) {
      await atomicJSON(file, { ...meta, state: 'failed', error: output });
      throw new Error(output);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await atomicJSON(file, { ...meta, state: 'failed', error: '포트 전달 시작 시간 초과' });
  throw new Error('포트 전달 시작 시간 초과.');
}
async function isForwardAlive(meta) {
  if (!Number.isSafeInteger(meta.linuxPid) || !/^[0-9]+$/.test(meta.startTicks || '')) return false;
  try {
    const ticks = await wsl(['sh', '-c', `awk '{print $22}' /proc/${meta.linuxPid}/stat`]);
    return ticks === meta.startTicks;
  } catch {
    return false;
  }
}
export async function stopForward(id, log) {
  await requireReady();
  const file = path.join(DATA, 'forwards', `${id}.json`);
  const meta = await readJSON(file);
  if (await isForwardAlive(meta)) await wsl(['kill', String(meta.linuxPid)]);
  await atomicJSON(file, { ...meta, state: 'stopped' });
  log('포트 전달을 종료했습니다.\n');
}
// 종료된 포트 전달 기록을 지운다. 엔진이 꺼져 있어도 기록은 지울 수 있다.
export async function removeForward(id, log) {
  const file = path.join(DATA, 'forwards', `${id}.json`);
  const meta = await readJSON(file);
  const active = (await distributions(true)).includes(DISTRO);
  if (active && (await isForwardAlive(meta)))
    throw new Error('실행 중인 포트 전달은 먼저 종료해 주세요.');
  if (active)
    await wsl(['rm', '-f', `/var/log/naru/forward-${id}.log`, `/run/naru/forwards/${id}.pid`]);
  await fs.rm(file);
  log('포트 전달 기록을 삭제했습니다.\n');
}
