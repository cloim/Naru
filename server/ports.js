import net from 'node:net';
import { DISTRO } from './state.js';
import { wsl, distributions } from './runner.js';

// Same ports as naru-boot and naru-agent. The relay connects to a target inside the engine namespace.
const RELAY_PORT = 29170;
const AGENT_PORT = 29171;
const WINDOWS_HOSTS = ['127.0.0.1', '::1'];
const TARGET = /^(?:127\.0\.0\.1|\[::1\]|198\.19\.249\.2):(\d{1,5})$/;
const forwards = new Map();
let relayHost = null;
let control = null;
let targets = [];
let ticking = false;
let lastError = '';

// The agent's list decides which Windows ports open; anything malformed is dropped.
export function validTargets(items) {
  return (Array.isArray(items) ? items : []).filter(
    (item) =>
      Number.isInteger(item?.port) &&
      item.port > 0 &&
      item.port < 65536 &&
      typeof item.target === 'string' &&
      Number(TARGET.exec(item.target)?.[1]) > 0,
  );
}

function relaySocket(target) {
  const socket = net.connect({ host: relayHost, port: RELAY_PORT, allowHalfOpen: true });
  socket.setNoDelay(true);
  socket.write(`${target}\n`);
  return socket;
}

function join(a, b) {
  a.setNoDelay(true);
  a.pipe(b).pipe(a);
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

// Returns false when the engine runs without its own namespace; callers then use their WSL path.
export function pipeRelay(socket, port) {
  if (!relayHost) return false;
  join(socket, relaySocket(String(port)));
  return true;
}

function open(port, target) {
  const entry = { target, servers: [], error: null };
  forwards.set(port, entry);
  for (const host of WINDOWS_HOSTS) {
    const server = net.createServer({ allowHalfOpen: true }, (socket) =>
      relayHost ? join(socket, relaySocket(target)) : socket.destroy(),
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
  targets = [];
  for (const port of [...forwards.keys()]) close(port);
}

function apply() {
  const wanted = new Map(validTargets(targets).map((item) => [item.port, item.target]));
  // Failed listeners are retried on every pass, e.g. after another program releases the port.
  for (const [port, entry] of forwards)
    if (wanted.get(port) !== entry.target || entry.error) close(port);
  for (const [port, target] of wanted) if (!forwards.has(port)) open(port, target);
}

// host.docker.internal: the agent holds a container connection until Windows localhost answers.
function openHost(id, port, hosts = ['127.0.0.1', '::1']) {
  const local = net.connect({ host: hosts[0], port, allowHalfOpen: true });
  local.once('error', () => {
    if (hosts.length > 1) return openHost(id, port, hosts.slice(1));
    control?.write(JSON.stringify({ type: 'fail', id }) + '\n');
  });
  local.once('connect', () => {
    local.removeAllListeners('error');
    const upstream = relaySocket(String(AGENT_PORT));
    upstream.write(`DATA ${id}\n`);
    join(local, upstream);
  });
}

function handle(message) {
  if (message.type === 'targets') {
    targets = message.items;
    apply();
  } else if (
    message.type === 'open' &&
    /^[0-9a-f]{32}$/.test(message.id) &&
    Number.isInteger(message.port) &&
    message.port > 0 &&
    message.port < 65536
  )
    openHost(message.id, message.port);
}

async function connect() {
  // Check the running list first; any wsl call would boot a stopped distribution.
  if (!(await distributions(true)).includes(DISTRO)) return closeAll();
  const host = await wsl(['sh', '-c', 'cat /run/naru/port-relay 2>/dev/null || true']);
  if (!net.isIPv4(host)) return closeAll();
  relayHost = host;
  const socket = relaySocket(String(AGENT_PORT));
  socket.write('CONTROL\n');
  control = socket;
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1))
      try {
        handle(JSON.parse(buffer.slice(0, end)));
      } catch (e) {
        report(e);
      }
  });
  socket.on('error', () => {});
  // The relay keeps half-open sockets; for the control channel, end means the agent is gone.
  socket.on('end', () => socket.destroy());
  socket.on('close', () => {
    if (control !== socket) return;
    control = null;
    // The agent restarts with the engine; reconnect soon, or close everything if the engine stopped.
    setTimeout(tick, 2000).unref();
  });
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
    if (!control) await connect();
    else if ([...forwards.values()].some((entry) => entry.error)) apply();
    lastError = '';
  } catch (e) {
    report(e);
  } finally {
    ticking = false;
  }
}

export function startPortForwarding() {
  tick();
  setInterval(tick, 10000).unref();
}

export function portForwardingStatus() {
  return {
    relay: relayHost,
    agent: !!control,
    ports: [...forwards].map(([port, entry]) => ({
      port,
      target: entry.target,
      error: entry.error,
    })),
  };
}
