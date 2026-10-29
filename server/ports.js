import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DATA, DISTRO, readJSON } from './state.js';
import { wsl, distributions } from './runner.js';
import { dockerRequest } from './engine.js';

// Same port as naru-boot. The relay reads the target port and connects to 127.0.0.1 in the engine namespace.
const RELAY_PORT = 29170;
const WINDOWS_HOSTS = ['127.0.0.1', '::1'];
const FORWARDS = path.join(DATA, 'forwards');
const EVENTS = `/events?filters=${encodeURIComponent(
  JSON.stringify({ type: ['container'], event: ['start', 'die', 'destroy'] }),
)}`;
const forwards = new Map();
let containerPorts = [];
let relayHost = null;
let events = null;
let syncTimer;
let ticking = false;
let lastError = '';

// The relay reaches IPv4 loopback, so only IPv4 wildcard and loopback bindings are forwarded.
export function publishedPorts(containers) {
  const ports = new Set();
  for (const container of containers)
    for (const p of container.Ports || [])
      if (p.Type === 'tcp' && p.PublicPort && ['0.0.0.0', '127.0.0.1'].includes(p.IP))
        ports.add(p.PublicPort);
  return [...ports].sort((a, b) => a - b);
}

// Returns false when the engine runs without its own namespace; callers then use their WSL path.
export function pipeRelay(socket, port) {
  if (!relayHost) return false;
  const upstream = net.connect({ host: relayHost, port: RELAY_PORT, allowHalfOpen: true });
  upstream.setNoDelay(true);
  socket.setNoDelay(true);
  upstream.write(`${port}\n`);
  socket.pipe(upstream).pipe(socket);
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  return true;
}

function open(port) {
  const entry = { servers: [], error: null };
  forwards.set(port, entry);
  for (const host of WINDOWS_HOSTS) {
    const server = net.createServer({ allowHalfOpen: true }, (socket) =>
      pipeRelay(socket, port) ? undefined : socket.destroy(),
    );
    server.on('error', (e) => {
      entry.error = `${host}:${port} ${e.code || e.message}`;
      console.error(`포트 전달 실패: ${entry.error}`);
    });
    server.listen(port, host);
    entry.servers.push(server);
  }
}

function close(port) {
  for (const server of forwards.get(port).servers) server.close();
  forwards.delete(port);
}

function closeAll() {
  relayHost = null;
  containerPorts = [];
  for (const port of [...forwards.keys()]) close(port);
}

// Kubernetes port-forward listens inside the engine namespace, so Windows needs the same relay.
async function kubernetesPorts() {
  const files = await fs.promises.readdir(FORWARDS).catch(() => []);
  const rows = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map((file) => readJSON(path.join(FORWARDS, file)).catch(() => null)),
  );
  return rows.filter((r) => ['starting', 'running'].includes(r?.state)).map((r) => r.localPort);
}

async function apply() {
  if (!relayHost) return;
  const wanted = new Set([...containerPorts, ...(await kubernetesPorts())]);
  // Failed listeners are retried on every pass, e.g. after another program releases the port.
  for (const [port, entry] of forwards) if (!wanted.has(port) || entry.error) close(port);
  for (const port of wanted) if (!forwards.has(port)) open(port);
}

async function sync() {
  containerPorts = publishedPorts(await dockerRequest('GET', '/containers/json'));
  await apply();
}

function schedule(work) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => work().catch((e) => report(e)), 300);
}

async function connect() {
  // Check the running list first; any wsl call would boot a stopped distribution.
  if (!(await distributions(true)).includes(DISTRO)) return closeAll();
  const host = await wsl(['sh', '-c', 'cat /run/naru/port-relay 2>/dev/null || true']);
  if (!net.isIPv4(host)) return closeAll();
  const stream = await dockerRequest('GET', EVENTS, undefined, { stream: true, pool: false });
  relayHost = host;
  events = stream;
  stream.on('data', () => schedule(sync));
  stream.on('error', () => {});
  stream.on('close', () => {
    if (events !== stream) return;
    events = null;
    tick();
  });
  await sync();
}

function report(e) {
  if (e.message === lastError) return;
  lastError = e.message;
  console.error(`포트 전달: ${e.message}`);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!events) await connect();
    else await apply();
    lastError = '';
  } catch (e) {
    report(e);
  } finally {
    ticking = false;
  }
}

export function startPortForwarding() {
  fs.mkdirSync(FORWARDS, { recursive: true });
  fs.watch(FORWARDS, () => schedule(apply)).on('error', (e) => report(e));
  tick();
  setInterval(tick, 10000).unref();
}

export function portForwardingStatus() {
  return {
    relay: relayHost,
    ports: [...forwards].map(([port, entry]) => ({ port, error: entry.error })),
  };
}
