// Measures how many SSH logins Naru makes to a remote engine while screens poll it, against a fake ssh.exe.
// No server is contacted: the fake answers Docker API routes and commands itself.
//
// Usage: node tests/ssh-churn.mjs <naru.exe> <fake_ssh.exe> [seconds=180] [pages=containers,diagnostics,detail]
//          [--fail-from=60 --fail-to=120] [--hidden-from=S] [--json]
// Build: cargo build -p naru && cargo build -p naru-core --example fake_ssh
// The server runs with NARU_API_ONLY in a temporary profile, so an installed Naru keeps running untouched.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [naruExe, fakeSsh] = process.argv.slice(2, 4);
if (!naruExe || !fakeSsh)
  throw new Error('usage: node tests/ssh-churn.mjs <naru.exe> <fake_ssh.exe> [seconds] [pages]');
const positional = process.argv.slice(4).filter((a) => !a.startsWith('--'));
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const seconds = Number(positional[0] || 180);
const pages = (positional[1] || 'containers,diagnostics,detail').split(',');
const failFrom = flag('fail-from') === undefined ? null : Number(flag('fail-from'));
const failTo = Number(flag('fail-to') ?? Infinity);
const hiddenFrom = flag('hidden-from') === undefined ? null : Number(flag('hidden-from'));
const port = 49300 + Math.floor(Math.random() * 200);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naru-ssh-churn-'));
const bin = path.join(root, 'bin');
const home = path.join(root, 'home');
const dataDir = path.join(root, 'data');
const config = path.join(home, '.config', 'Naru');
const log = path.join(root, 'ssh.log');
const failFile = path.join(root, 'fail');
for (const dir of [bin, config, dataDir]) fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(fakeSsh, path.join(bin, 'ssh.exe'));
fs.writeFileSync(
  path.join(config, 'app.json'),
  JSON.stringify({ dataDir, port, onboarded: true, launchAtLogin: false }),
);
fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ autoStart: false }));
const profile = {
  id: 'fake-remote',
  name: 'fake',
  host: 'fake.invalid',
  user: 'root',
  port: 22222,
  identityFile: '',
  scopeId: 'fake-remote',
  revision: 'r1',
};
fs.writeFileSync(
  path.join(config, 'engines.json'),
  JSON.stringify({ selected: profile.id, profiles: [profile] }),
);

const server = spawn(naruExe, ['--serve'], {
  env: {
    ...process.env,
    USERPROFILE: home,
    NARU_DATA_DIR: dataDir,
    NARU_API_ONLY: '1',
    PATH: `${bin};${process.env.PATH}`,
    FAKE_SSH_LOG: log,
    FAKE_SSH_FAIL_FILE: failFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (d) => (serverOutput += d));
server.stderr.on('data', (d) => (serverOutput += d));

const base = `http://127.0.0.1:${port}`;
let token;
for (let i = 0; i < 300 && !token; i++) {
  try {
    token = (await fetch(base + '/api/session').then((r) => r.json())).token;
  } catch {
    await delay(100);
  }
}
if (!token) throw new Error('server did not start:\n' + serverOutput);

const headers = {
  'Content-Type': 'application/json',
  'X-Naru-Token': token,
  'X-Naru-Engine': profile.id,
  'X-Naru-Engine-Revision': profile.revision,
};
const stats = { requests: 0, errors: 0, errorSamples: new Map() };
async function get(route) {
  stats.requests++;
  try {
    const response = await fetch(base + '/api' + route, { headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  } catch (e) {
    stats.errors++;
    const key = String(e.message).replace(/\d+/g, 'N').slice(0, 120);
    stats.errorSamples.set(key, (stats.errorSamples.get(key) || 0) + 1);
    return null;
  }
}

// The intervals the screens use (React Query refetchInterval); a query never overlaps itself.
const queries = [
  ['/status', 5000],
  ['/jobs', 10000],
];
const id = 'abc123abc123abc123';
if (pages.includes('containers'))
  queries.push(['/containers', 5000], ['/projects', 5000], ['/containers/locks', 5000]);
if (pages.includes('diagnostics'))
  queries.push(['/diagnostics', 5000], ['/diagnostics/resources', 3000]);
if (pages.includes('detail'))
  queries.push(
    [`/containers/${id}/logs`, 5000],
    [`/containers/${id}/stats`, 5000],
    ['/containers/locks', 5000],
  );

const started = Date.now();
const elapsed = () => (Date.now() - started) / 1000;
let running = true;
const visible = () => hiddenFrom === null || elapsed() < hiddenFrom;
const loops = queries.map(async ([route, every]) => {
  while (running) {
    const at = Date.now();
    if (visible()) await get(route);
    await delay(Math.max(0, every - (Date.now() - at)));
  }
});

// Live fake ssh processes: started, not ended, and still alive.
const events = () =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [ms, pid, event, ...rest] = l.split('\t');
          return { ms: Number(ms), pid: Number(pid), event, remote: rest.join('\t') };
        })
    : [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const livePids = () => {
  const ended = new Set();
  const startedPids = new Set();
  for (const e of events()) (e.event === 'start' ? startedPids : ended).add(e.pid);
  return [...startedPids].filter((p) => !ended.has(p) && alive(p));
};
let peak = 0;
const timeline = [];
const sampler = (async () => {
  while (running) {
    const t = elapsed();
    if (failFrom !== null) {
      const failing = t >= failFrom && t < failTo;
      if (failing && !fs.existsSync(failFile)) fs.writeFileSync(failFile, '');
      if (!failing && fs.existsSync(failFile)) fs.rmSync(failFile);
    }
    const live = livePids().length;
    peak = Math.max(peak, live);
    timeline.push([t, live]);
    await delay(250);
  }
})();

await delay(seconds * 1000);
running = false;
await Promise.all([...loops, sampler]);
const leftAfterStop = livePids().length;
await delay(3000);
const leftAfterIdle = livePids();
server.kill();
await delay(1500);
const leftAfterExit = livePids();
for (const pid of leftAfterExit) {
  try {
    process.kill(pid);
  } catch {}
}

const all = events().filter((e) => e.event === 'start');
const t0 = started;
const perMinute = [];
for (let m = 0; m < Math.ceil(seconds / 60); m++)
  perMinute.push(all.filter((e) => e.ms >= t0 + m * 60000 && e.ms < t0 + (m + 1) * 60000).length);
const byCommand = {};
for (const e of all) {
  const words = e.remote.match(/'[^']*'/g)?.map((w) => w.slice(1, -1)) || [e.remote];
  const key = words.slice(0, words[0] === 'docker' ? (words[1] === 'system' ? 3 : 2) : 1).join(' ');
  byCommand[key] = (byCommand[key] || 0) + 1;
}
const result = {
  seconds,
  pages,
  failWindow: failFrom === null ? null : [failFrom, failTo],
  hiddenFrom,
  sshStarts: all.length,
  sshPerMinute: Number(((all.length / seconds) * 60).toFixed(1)),
  perMinute,
  byCommand,
  peakConcurrent: peak,
  liveAfterPollingStopped: leftAfterStop,
  liveAfter3sIdle: leftAfterIdle.length,
  liveAfterServerExit: leftAfterExit.length,
  apiRequests: stats.requests,
  apiErrors: stats.errors,
  errorSamples: Object.fromEntries(stats.errorSamples),
};
console.log(JSON.stringify(result, null, 2));
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
