import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse, stringify } from 'yaml';
import { DATA, ROOT, DISTRO, settings, atomicJSON } from './state.js';
import { command, wsl, distributions, detached } from './runner.js';

export async function requireManaged() {}

export const BASE = {
  version: '0.100',
  sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  url: 'https://github.com/example/base-distro/releases/download/v0.100/base-distro.tar',
};
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function download(url, dest, log) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok) throw new Error(`다운로드 실패: HTTP ${response.status} ${url}`);
  const temp = dest + '.partial';
  let bytes = 0,
    last = 0;
  const stream = Readable.fromWeb(response.body);
  stream.on('data', (chunk) => {
    bytes += chunk.length;
    if (Date.now() - last > 2000) {
      log?.(`다운로드 ${(bytes / 1048576).toFixed(1)} MB\n`);
      last = Date.now();
    }
  });
  await pipeline(stream, createWriteStream(temp));
  await fs.rename(temp, dest);
}
export async function status() {
  const [all, running, cfg] = await Promise.all([distributions(), distributions(true), settings()]);
  const installed = all.includes(DISTRO),
    active = running.includes(DISTRO);
  let health = null,
    error = null;
  if (active)
    try {
      if (cfg.engine === 'moby')
        health = JSON.parse(
          await wsl(
            [
              'curl',
              '-sf',
              '--max-time',
              '2',
              '--unix-socket',
              '/run/naru/docker.sock',
              'http://localhost/info',
            ],
            { timeout: 5000 },
          ),
        );
      else
        health = JSON.parse(
          await wsl(
            [
              '/usr/bin/nerdctl',
              '--address',
              '/run/naru/containerd.sock',
              'info',
              '--format',
              '{{json .}}',
            ],
            { timeout: 5000 },
          ),
        );
    } catch (e) {
      error = e.message;
    }
  return {
    connection: 'managed',
    managed: true,
    installed,
    running: active,
    ready: !!health,
    engine: cfg.engine,
    kubernetes: cfg.kubernetes,
    health,
    error,
    distro: DISTRO,
    dataPath: DATA,
    pollSeconds: cfg.pollSeconds,
  };
}
export async function requireReady() {
  const running = await distributions(true);
  if (!running.includes(DISTRO)) throw new Error('Naru 엔진을 먼저 시작해 주세요.');
}
export async function exportKubeconfig() {
  await requireManaged();
  await requireReady();
  const config = parse(await wsl(['cat', '/etc/naru/kubeconfig']));
  if (config.clusters?.length !== 1 || config.contexts?.length !== 1 || config.users?.length !== 1)
    throw new Error('k3s kubeconfig 구조를 확인해 주세요.');
  config.clusters[0].name = 'naru';
  config.users[0].name = 'naru';
  config.contexts[0].name = 'naru';
  config.contexts[0].context.cluster = 'naru';
  config.contexts[0].context.user = 'naru';
  config['current-context'] = 'naru';
  const text = stringify(config);
  await fs.writeFile(path.join(DATA, 'kubeconfig.yaml'), text, { mode: 0o600 });
  return text;
}
export async function install(log) {
  await requireManaged();
  if ((await distributions()).includes(DISTRO))
    throw new Error('Naru 배포판이 이미 설치되어 있습니다.');
  await fs.mkdir(path.join(DATA, 'cache'), { recursive: true });
  const tar = path.join(DATA, 'cache', 'base-distro.tar');
  try {
    await fs.access(tar);
  } catch {
    await download(BASE.url, tar, log);
  }
  log('공식 SHA256으로 배포판을 검증합니다.\n');
  if ((await sha256(tar)) !== BASE.sha256) {
    const observed = await sha256(tar);
    log(
      `로컬 배포판은 공식 릴리스와 다릅니다 (${observed}). 원본을 보존하고 공식 릴리스를 받습니다.\n`,
    );
    await fs.rename(tar, tar + `.unverified-${Date.now()}`);
    await download(BASE.url, tar, log);
    if ((await sha256(tar)) !== BASE.sha256)
      throw new Error('공식 릴리스 배포판 SHA256 검증 실패.');
  }
  const location = path.join(DATA, 'wsl');
  await fs.mkdir(location, { recursive: true });
  await command('wsl.exe', ['--import', DISTRO, location, tar, '--version', '2'], {
    timeout: 180000,
    log,
  });
  // Replace upstream-specific DNS settings; never start upstream networking helpers.
  const conf =
    '[automount]\nmountFsTab=false\noptions=metadata\n[network]\ngenerateHosts=true\ngenerateResolvConf=true\n[user]\ndefault=root\n';
  await wsl(
    [
      'sh',
      '-c',
      'cat > /etc/wsl.conf; rm -f /etc/resolv.conf /etc/hosts; mkdir -p /etc/naru /var/lib/naru /var/log/naru',
    ],
    { input: conf, log },
  );
  await installScripts(log);
  await wsl(['/usr/local/bin/naru-layout']);
  await command('wsl.exe', ['--terminate', DISTRO], { timeout: 30000 });
  await atomicJSON(path.join(DATA, 'provenance.json'), {
    base: BASE,
    installedAt: new Date().toISOString(),
    upstream: 'WSL distro (Apache-2.0)',
    independent: true,
  });
  log('Naru 전용 WSL2 배포판 설치 완료.\n');
}
async function installScripts(log) {
  for (const name of ['naru-boot.sh', 'naru-k3s.sh', 'naru-layout.sh']) {
    const contents = (await fs.readFile(path.join(ROOT, 'scripts', name), 'utf8')).replace(
      /\r/g,
      '',
    );
    const dest = `/usr/local/bin/${name.replace('.sh', '')}`;
    await wsl(['sh', '-c', `cat > ${dest}; chmod 755 ${dest}`], { input: contents, log });
  }
}
export async function start(log) {
  await requireManaged();
  const cfg = await settings();
  const current = await status();
  if (!current.installed) throw new Error('Naru 런타임 설치를 먼저 실행해 주세요.');
  if (current.ready) {
    log('엔진이 이미 준비되었습니다.\n');
    return;
  }
  await installScripts(log);
  // Pass proxy values as env arguments, never interpolate into a shell program.
  const proxy = [
    'HTTP_PROXY=' + cfg.proxy.http,
    'HTTPS_PROXY=' + cfg.proxy.https,
    'NO_PROXY=' + cfg.proxy.noProxy,
  ];
  const pid = await detached('wsl.exe', [
    '-d',
    DISTRO,
    '-u',
    'root',
    '--exec',
    'env',
    ...proxy,
    '/usr/local/bin/naru-boot',
    cfg.engine,
  ]);
  log(`독립 WSL supervisor 시작, PID ${pid}\n`);
  for (let i = 0; i < 45; i++) {
    try {
      if (cfg.engine === 'moby')
        await wsl(
          [
            'curl',
            '-sf',
            '--max-time',
            '2',
            '--unix-socket',
            '/run/naru/docker.sock',
            'http://localhost/_ping',
          ],
          { timeout: 5000 },
        );
      else
        await wsl(
          ['/usr/bin/nerdctl', '--address', '/run/naru/containerd.sock', 'info'],
          { timeout: 5000 },
        );
      log('컨테이너 엔진 응답 확인.\n');
      if (cfg.kubernetes.enabled) await startKubernetes(log);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const tail = await wsl(['tail', '-n', '60', '/var/log/naru/engine.log']);
  throw new Error('엔진 시작 실패:\n' + tail);
}
export async function stop(log) {
  await requireManaged();
  if (!(await distributions(true)).includes(DISTRO)) {
    log('이미 종료되어 있습니다.\n');
    return;
  }
  // Graceful shutdown first, then terminate this distribution only.
  await wsl([
    'sh',
    '-c',
    'for file in /run/naru/k3s.pid /run/naru/supervisor.pid; do if [ -f "$file" ]; then kill "$(cat "$file")" 2>/dev/null || true; fi; done',
  ]);
  for (let i = 0; i < 30; i++) {
    try {
      await wsl(['test', '!', '-f', '/run/naru/supervisor.pid']);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      if (i === 29) throw new Error('엔진 정상 종료 제한 시간 초과. 로그를 확인해 주세요.');
    }
  }
  await command('wsl.exe', ['--terminate', DISTRO], { timeout: 30000 });
  log('Naru 배포판 종료 완료.\n');
}
export async function startKubernetes(log) {
  await requireManaged();
  await requireReady();
  const cfg = await settings();
  const version = cfg.kubernetes.version;
  const stored = await wsl(['sh', '-c', 'cat /etc/naru/k3s-version 2>/dev/null || true']);
  if (stored !== version) {
    const cache = path.join(DATA, 'cache', version);
    await fs.mkdir(cache, { recursive: true });
    const url = `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(version)}`;
    const sums = await fetch(`${url}/sha256sum-amd64.txt`, { signal: AbortSignal.timeout(30000) });
    if (!sums.ok) throw new Error('k3s 버전 또는 체크섬을 확인할 수 없습니다.');
    const expected = (await sums.text())
      .split('\n')
      .find((line) => /\s+\*?k3s$/.test(line))
      ?.split(/\s+/)[0];
    if (!expected) throw new Error('k3s 체크섬 항목이 없습니다.');
    const binary = path.join(cache, 'k3s');
    try {
      await fs.access(binary);
    } catch {
      await download(`${url}/k3s`, binary, log);
    }
    if ((await sha256(binary)) !== expected) throw new Error('k3s SHA256 검증 실패.');
    const linuxPath = await wsl(['wslpath', '-a', binary]);
    await wsl(['cp', linuxPath, '/usr/local/bin/k3s']);
    await wsl(['chmod', '755', '/usr/local/bin/k3s']);
    await wsl(['sh', '-c', 'cat > /etc/naru/k3s-version'], { input: version });
  }
  await detached('wsl.exe', [
    '-d',
    DISTRO,
    '-u',
    'root',
    '--exec',
    '/usr/local/bin/naru-k3s',
    cfg.engine,
    String(cfg.kubernetes.port),
    String(cfg.kubernetes.traefik),
  ]);
  log(`k3s ${version} 시작, readiness 확인 중\n`);
  for (let i = 0; i < 120; i++) {
    try {
      await wsl(
        [
          '/usr/local/bin/k3s',
          'kubectl',
          '--kubeconfig',
          '/etc/naru/kubeconfig',
          'get',
          '--raw=/readyz',
        ],
        { timeout: 5000 },
      );
      await exportKubeconfig();
      log('Kubernetes API 준비 완료. Naru 전용 Windows kubeconfig를 저장했습니다.\n');
      return;
    } catch {
      if (i > 3)
        try {
          await wsl([
            'sh',
            '-c',
            'test -f /run/naru/k3s.pid && kill -0 "$(cat /run/naru/k3s.pid)"',
          ]);
        } catch {
          throw new Error(
            'k3s 프로세스 종료:\n' +
              (await wsl(['tail', '-n', '8', '/var/log/naru/kubernetes.log'])),
          );
        }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Kubernetes 준비 시간 초과. 진단의 Kubernetes 로그를 확인해 주세요.');
}
export async function stopKubernetes(log) {
  await requireManaged();
  await requireReady();
  await wsl(['sh', '-c', 'if [ -f /run/naru/k3s.pid ]; then kill "$(cat /run/naru/k3s.pid)"; fi']);
  log('Kubernetes 종료 요청 완료.\n');
}
export async function snapshot(name, log) {
  await requireManaged();
  const s = await status();
  const id = crypto.randomUUID();
  const file = path.join(DATA, 'snapshots', `${id}.tar`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (s.running) await stop(log);
  try {
    await command('wsl.exe', ['--export', DISTRO, file], { timeout: 15 * 60 * 1000, log });
    const stat = await fs.stat(file);
    await atomicJSON(path.join(DATA, 'snapshots', `${id}.json`), {
      id,
      name,
      createdAt: new Date().toISOString(),
      bytes: stat.size,
      settings: await settings(),
      sha256: await sha256(file),
    });
    log('일관된 정지 상태의 스냅샷 저장 완료.\n');
  } finally {
    if (s.ready) await start(log);
  }
}
