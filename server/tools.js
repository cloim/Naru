import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA, settings, atomicJSON, readJSON, containerProxyConfig } from './state.js';
import { wsl, command } from './runner.js';
import * as runtime from './runtime.js';

// The Windows Docker CLI and buildx pass these proxies to containers and BuildKit builds.
// A proxy the user configured there stays; Naru only replaces or removes the value it wrote.
export async function syncCliProxies() {
  const proxies = containerProxyConfig((await settings()).proxy);
  const file = path.join(
    process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker'),
    'config.json',
  );
  const record = path.join(DATA, 'docker', 'cli-proxies.json');
  const config = await readJSON(file, {});
  const current = JSON.stringify(config.proxies?.default ?? null);
  if (current === JSON.stringify(proxies)) return;
  if (current !== 'null' && current !== JSON.stringify(await readJSON(record, null))) return;
  if (proxies) config.proxies = { ...config.proxies, default: proxies };
  else {
    delete config.proxies.default;
    if (!Object.keys(config.proxies).length) delete config.proxies;
  }
  await atomicJSON(file, config);
  await atomicJSON(record, proxies);
}

// Official tool versions; archives are verified before extraction.
export const windowsTools = {
  docker: {
    file: 'docker.exe',
    url: 'https://download.docker.com/win/static/stable/x86_64/docker-29.9.2.zip',
    sha256: 'b2be959bfed1281ddaf665c0972cba9a62ce30c542b6bcce82f055bf8886bc7d',
    entry: 'docker/docker.exe',
  },
  compose: {
    file: 'cli-plugins/docker-compose.exe',
    url: 'https://github.com/docker/compose/releases/download/v5.3.1/docker-compose-windows-x86_64.exe',
    sha256: '6d36cc701393c066d67ebc77773b718d8c738bc4ccb350fbf1dc0e6a09f44cb9',
  },
  buildx: {
    file: 'cli-plugins/docker-buildx.exe',
    url: 'https://github.com/docker/buildx/releases/download/v0.35.0/buildx-v0.35.0.windows-amd64.exe',
    sha256: '8076395009787cd1d30c94edeb5d7ac3945273374fc162c00e9810c3e9325ebe',
  },
  wincred: {
    file: 'docker-credential-wincred.exe',
    url: 'https://github.com/docker/docker-credential-helpers/releases/download/v0.9.8/docker-credential-wincred-v0.9.8.windows-amd64.exe',
    sha256: 'fec0aa06335bbefc7f515630c9368afaa1423fa9fa585112f123b6625f72d560',
  },
  helm: {
    file: 'helm.exe',
    url: 'https://get.helm.sh/helm-v4.2.3-windows-amd64.tar.gz',
    sha256: '02c6137bb5f050479193afad5a28804e9edc3beeab7e7b53a6e1499c9ba387ef',
    entry: 'windows-amd64/helm.exe',
  },
};
export async function ensureWindowsTool(name, log = () => {}) {
  let spec = windowsTools[name];
  if (name === 'kubectl') {
    const version = (await settings()).kubernetes.version.split('+')[0],
      url = `https://dl.k8s.io/release/${version}/bin/windows/amd64/kubectl.exe`;
    const existing = path.join(DATA, 'bin', 'kubectl.exe');
    try {
      const record = JSON.parse(await fs.readFile(existing + '.provenance.json', 'utf8'));
      if (record.url === url && record.sha256 === (await runtime.sha256(existing))) return existing;
    } catch {}
    const response = await fetch(url + '.sha256', { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('kubectl 체크섬 다운로드 실패.');
    const digest = (await response.text()).trim();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('kubectl 체크섬 형식 오류.');
    spec = { file: 'kubectl.exe', url, sha256: digest };
  }
  if (!spec) throw new Error('알 수 없는 도구: ' + name);
  const dest = path.join(DATA, 'bin', spec.file);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const cache = path.join(DATA, 'cache', 'tools', path.basename(spec.url));
  await fs.mkdir(path.dirname(cache), { recursive: true });
  if (!spec.entry)
    try {
      if ((await runtime.sha256(dest)) === spec.sha256) return dest;
    } catch {}
  if (spec.entry)
    try {
      const record = JSON.parse(await fs.readFile(dest + '.provenance.json', 'utf8'));
      if (record.archiveSha256 === spec.sha256 && record.sha256 === (await runtime.sha256(dest)))
        return dest;
    } catch {}
  try {
    if ((await runtime.sha256(cache)) !== spec.sha256) await fs.unlink(cache);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    await fs.access(cache);
  } catch {
    log(`공식 도구 다운로드: ${name}\n`);
    await runtime.download(spec.url, cache, log);
  }
  if ((await runtime.sha256(cache)) !== spec.sha256) throw new Error(`${name} SHA256 검증 실패.`);
  // Previously copied installers can retain the source file's Windows read-only attribute.
  try {
    await fs.chmod(dest, 0o600);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (spec.entry) {
    const stage = path.join(DATA, 'cache', 'tools', 'extract-' + name);
    await fs.mkdir(stage, { recursive: true });
    await command('tar.exe', ['-xf', cache, '-C', stage, spec.entry]);
    await fs.copyFile(path.join(stage, spec.entry), dest);
  } else await fs.copyFile(cache, dest);
  await atomicJSON(dest + '.provenance.json', {
    url: spec.url,
    archiveSha256: spec.sha256,
    sha256: await runtime.sha256(dest),
  });
  return dest;
}

export async function ensureCompose(log) {
  try {
    await wsl(['test', '-x', '/usr/libexec/docker/cli-plugins/docker-compose']);
    return;
  } catch {}
  const version = 'v2.39.4',
    url = `https://github.com/docker/compose/releases/download/${version}/docker-compose-linux-x86_64`;
  const binary = path.join(DATA, 'cache', 'docker-compose-linux-x86_64');
  await runtime.download(url, binary, log);
  const response = await fetch(url + '.sha256', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Compose checksum 다운로드 실패.');
  const expected = (await response.text()).trim().split(/\s+/)[0];
  if ((await runtime.sha256(binary)) !== expected) throw new Error('Compose 체크섬 검증 실패.');
  const linux = await wsl(['wslpath', '-a', binary]);
  await wsl(['cp', linux, '/usr/libexec/docker/cli-plugins/docker-compose']);
  await wsl(['chmod', '755', '/usr/libexec/docker/cli-plugins/docker-compose']);
}
