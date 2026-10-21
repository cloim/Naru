import net from 'node:net';
import path from 'node:path';
import { DATA } from './state.js';
import { command } from './runner.js';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { settings, DISTRO } from './state.js';
import { wsl, assertDistroAvailable } from './runner.js';
import { requireReady } from './runtime.js';

// The engine socket stays inside WSL. No unauthenticated Docker TCP port is exposed.
let sharedAgent;
export function enableDockerPool() {
  sharedAgent = createAgent(true);
}
function createAgent(keepAlive) {
  const agent = new http.Agent({ keepAlive, maxSockets: 6, maxFreeSockets: 2, timeout: 10000 });
  agent.createConnection = () => naruSocket();
  return agent;
}
// A socket-like stream to the engine's Unix socket inside the naru distribution.
export function naruSocket() {
  try {
    assertDistroAvailable();
  } catch (e) {
    const blocked = new Duplex({ read() {}, write: (chunk, encoding, done) => done() });
    // 실제 소켓처럼 기본 오류 수신자를 둔다. 요청 쪽은 에이전트가 붙인 수신자로 오류를 받는다.
    blocked.on('error', () => {});
    process.nextTick(() => blocked.destroy(e));
    return blocked;
  }
  const p = spawn(
    'wsl.exe',
    ['-d', DISTRO, '-u', 'root', '--exec', 'socat', '-', 'UNIX-CONNECT:/run/naru/docker.sock'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const socket = Duplex.from({ readable: p.stdout, writable: p.stdin });
  // Agent removes its listeners before destroy; Duplexify may emit ABORT_ERR during teardown.
  socket.on('error', () => {});
  let idleTimer, onTimeout;
  // Pooled sockets get a new timeout callback on every reuse; keep only the latest one.
  socket.setTimeout = (milliseconds, callback) => {
    clearTimeout(idleTimer);
    if (callback) {
      if (onTimeout) socket.removeListener('timeout', onTimeout);
      onTimeout = callback;
      socket.once('timeout', callback);
    }
    if (milliseconds) idleTimer = setTimeout(() => socket.emit('timeout'), milliseconds).unref();
    return socket;
  };
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;
  socket.ref = () => {
    socket.setTimeout(0);
    return socket;
  };
  socket.unref = () => socket;
  p.on('error', (e) => socket.destroy(e));
  p.stderr.on('data', () => {});
  socket.on('close', () => {
    clearTimeout(idleTimer);
    if (!p.killed) p.kill();
  });
  return socket;
}
export async function dockerRequest(method, route, body, { timeout = 30000, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const agent = sharedAgent || createAgent(false);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: 'localhost',
        path: route,
        method,
        agent,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        if (stream && res.statusCode < 400) {
          clearTimeout(timer);
          resolve(res);
          return;
        }
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (data.length > 16 * 1024 * 1024) req.destroy(new Error('응답 크기 제한 초과'));
        });
        res.on('end', () => {
          clearTimeout(timer);
          if (agent !== sharedAgent) agent.destroy();
          if (res.statusCode >= 400) {
            try {
              data = JSON.parse(data).message || data;
            } catch {}
            reject(new Error(data || `Docker HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('Docker API 응답 시간 초과')), timeout);
    req.on('error', (e) => {
      clearTimeout(timer);
      if (agent !== sharedAgent) agent.destroy();
      reject(e);
    });
    req.end(payload);
  });
}
export async function cli(args, options = {}) {
  await requireReady();
  const cfg = await settings();
  const namespace = options.namespace ?? cfg.namespace;
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(namespace))
    throw new Error('containerd 네임스페이스 형식이 잘못되었습니다.');
  const prefix =
    cfg.engine === 'moby'
      ? [
          'env',
          'DOCKER_CONFIG=/etc/naru/docker',
          'DOCKER_HOST=unix:///run/naru/docker.sock',
          'docker',
        ]
      : [
          'env',
          'DOCKER_CONFIG=/etc/naru/docker',
          'CNI_PATH=/usr/libexec/cni',
          'BUILDKIT_HOST=unix:///run/naru/buildkitd.sock',
          '/usr/bin/nerdctl',
          '--address',
          '/run/naru/containerd.sock',
          '--namespace',
          namespace,
          '--cni-netconfpath',
          '/etc/naru/cni/net.d',
        ];
  return wsl([...prefix, ...args], options);
}
export const lines = (text) =>
  text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((x) => JSON.parse(x));
function parseLabels(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const labels = {};
  for (const part of String(raw).split(',')) {
    const idx = part.indexOf('=');
    if (idx !== -1) labels[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return labels;
}
export async function list(kind) {
  await requireReady();
  const cfg = await settings();
  if (cfg.engine === 'moby') {
    const routes = {
      containers: '/containers/json?all=true',
      images: '/images/json',
      volumes: '/volumes',
      networks: '/networks',
    };
    const result = await dockerRequest('GET', routes[kind]);
    return kind === 'volumes' ? result.Volumes || [] : result;
  }
  if (kind === 'containers')
    return lines(await cli(['ps', '-a', '--format', '{{json .}}'])).map((x) => ({
      Id: x.ID,
      Names: [x.Names],
      Image: x.Image,
      State: x.Status?.startsWith('Up') ? 'running' : 'exited',
      Status: x.Status,
      Ports: [],
      Command: x.Command,
      Labels: {},
    }));
  if (kind === 'images')
    return lines(await cli(['images', '--format', '{{json .}}'])).map((x) => ({
      Id: x.ID,
      RepoTags: [`${x.Repository}:${x.Tag}`],
      Size: x.Size,
      Created: x.CreatedAt,
    }));
  return lines(
    await cli([kind === 'volumes' ? 'volume' : 'network', 'ls', '--format', '{{json .}}']),
  ).map((x) =>
    kind === 'volumes'
      ? { Name: x.Name, Driver: x.Driver, Mountpoint: x.Mountpoint, Labels: parseLabels(x.Labels) }
      : { Id: x.ID, Name: x.Name, Driver: x.Driver, Scope: x.Scope },
  );
}
export async function inspect(kind, id) {
  const cfg = await settings();
  await requireReady();
  if (cfg.engine === 'moby')
    return dockerRequest(
      'GET',
      `/${kind}/${encodeURIComponent(id)}${['volumes', 'networks'].includes(kind) ? '' : '/json'}`,
    );
  return JSON.parse(
    await cli([
      kind === 'containers'
        ? 'container'
        : kind === 'images'
          ? 'image'
          : kind === 'volumes'
            ? 'volume'
            : 'network',
      'inspect',
      id,
    ]),
  );
}
export async function containerAction(id, action, log) {
  const cfg = await settings();
  await requireReady();
  if (cfg.engine === 'moby') {
    const result = await dockerRequest(
      action === 'remove' ? 'DELETE' : 'POST',
      `/containers/${encodeURIComponent(id)}${action === 'remove' ? '' : `/${action}`}?t=10`,
    );
    log('컨테이너 작업 완료.\n');
    return result;
  }
  return cli([action === 'remove' ? 'rm' : action, id], { log, timeout: 60000 });
}
export async function logs(id, tail = 300) {
  return cli(['logs', '--timestamps', '--tail', String(tail), id], {
    timeout: 15000,
    combine: true,
  });
}
export function decodeDockerStream(buffer) {
  const chunks = [];
  let offset = 0;
  while (
    offset + 8 <= buffer.length &&
    [0, 1, 2].includes(buffer[offset]) &&
    buffer.readUIntBE(offset + 1, 3) === 0
  ) {
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : buffer.toString('utf8');
}

export async function getPrunePreview(kind) {
  await requireReady();
  const cfg = await settings();
  if (cfg.engine === 'moby') {
    const [rawContainers, rawItems] = await Promise.all([
      dockerRequest('GET', '/containers/json?all=true'),
      dockerRequest(
        'GET',
        kind === 'volumes' ? '/volumes' : kind === 'networks' ? '/networks' : '/images/json',
      ),
    ]);
    const containers = rawContainers || [];
    if (kind === 'images') {
      const usedIds = new Set();
      const usedNames = new Set();
      for (const c of containers) {
        if (c.ImageID) {
          const id = c.ImageID.replace('sha256:', '');
          usedIds.add(id);
          usedIds.add(id.slice(0, 12));
        }
        if (c.Image) {
          usedNames.add(c.Image);
          if (c.Image.startsWith('sha256:')) {
            const id = c.Image.replace('sha256:', '');
            usedIds.add(id);
            usedIds.add(id.slice(0, 12));
          }
        }
      }
      const images = rawItems || [];
      const unused = images.filter((img) => {
        const fullId = (img.Id || '').replace('sha256:', '');
        const shortId = fullId.slice(0, 12);
        if (usedIds.has(fullId) || usedIds.has(shortId)) return false;
        const tags = img.RepoTags || [];
        if (tags.some((tag) => usedNames.has(tag))) return false;
        return true;
      });
      return unused.map((img) => ({
        id: (img.Id || '').replace('sha256:', '').slice(0, 12),
        name:
          img.RepoTags && img.RepoTags[0] && img.RepoTags[0] !== '<none>:<none>'
            ? img.RepoTags[0]
            : img.Id
              ? img.Id.replace('sha256:', '').slice(0, 12)
              : '—',
        size: img.Size || 0,
      }));
    }
    if (kind === 'volumes') {
      const usedVolumeNames = new Set();
      for (const c of containers) {
        for (const m of c.Mounts || []) {
          if (m.Name) usedVolumeNames.add(m.Name);
        }
      }
      const volumes = rawItems?.Volumes || [];
      const unused = volumes.filter((v) => !usedVolumeNames.has(v.Name));
      return unused.map((v) => ({
        name: v.Name,
        driver: v.Driver || 'local',
      }));
    }
    if (kind === 'networks') {
      const defaultNetworks = new Set(['bridge', 'host', 'none']);
      const usedNetworkNames = new Set();
      const usedNetworkIds = new Set();
      for (const c of containers) {
        const nets = c.NetworkSettings?.Networks || {};
        for (const [netName, netObj] of Object.entries(nets)) {
          usedNetworkNames.add(netName);
          if (netObj.NetworkID) {
            usedNetworkIds.add(netObj.NetworkID);
            usedNetworkIds.add(netObj.NetworkID.slice(0, 12));
          }
        }
      }
      const networks = rawItems || [];
      const unused = networks.filter((n) => {
        if (defaultNetworks.has(n.Name)) return false;
        if (usedNetworkNames.has(n.Name)) return false;
        const fullId = n.Id || '';
        const shortId = fullId.slice(0, 12);
        if (usedNetworkIds.has(fullId) || usedNetworkIds.has(shortId)) return false;
        return true;
      });
      return unused.map((n) => ({
        id: (n.Id || '').slice(0, 12),
        name: n.Name,
        driver: n.Driver,
      }));
    }
  }

  const containers = await list('containers');
  const items = await list(kind);
  if (kind === 'images') {
    const usedNames = new Set(containers.map((c) => c.Image).filter(Boolean));
    const unused = items.filter((img) => {
      const tags = img.RepoTags || [];
      return !tags.some((tag) => usedNames.has(tag));
    });
    return unused.map((img) => ({
      id: (img.Id || '').slice(0, 12),
      name: img.RepoTags?.[0] || img.Id?.slice(0, 12) || '—',
      size: typeof img.Size === 'number' ? img.Size : 0,
    }));
  }
  if (kind === 'volumes') {
    return items.map((v) => ({
      name: v.Name,
      driver: v.Driver || 'local',
    }));
  }
  if (kind === 'networks') {
    const defaultNetworks = new Set(['bridge', 'host', 'none']);
    const unused = items.filter((n) => !defaultNetworks.has(n.Name));
    return unused.map((n) => ({
      id: (n.Id || '').slice(0, 12),
      name: n.Name,
      driver: n.Driver,
    }));
  }
  return [];
}
