import { settings, containerProxyConfig } from './state.js';
import net from 'node:net';
import http from 'node:http';
import { naruSocket } from './engine.js';
import { createRewriter, rewriteBuildUrl } from './paths.js';
import { spawn } from 'node:child_process';
import { DISTRO } from './state.js';
import { requireReady } from './runtime.js';
import { killProcess } from './runner.js';
import { pipeRelay } from './ports.js';

const NARU_PIPE = '\\\\.\\pipe\\naru_engine';
const DOCKER_PIPE = '\\\\.\\pipe\\docker_engine';
const BODY_LIMIT = 16 * 1024 * 1024;

// Speaks HTTP to the engine so Windows host paths can be translated.
// Everything else, including hijacked attach/exec streams, passes through.
const engineAgent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 4 });
engineAgent.createConnection = () => naruSocket();
const engineProxy = http.createServer({ requestTimeout: 0, keepAliveTimeout: 60000 }, proxyRequest);
engineProxy.timeout = 0;
engineProxy.on('upgrade', proxyUpgrade);
engineProxy.on('clientError', (e, socket) => socket.destroy());

async function proxyRequest(req, res) {
  const headers = { ...req.headers };
  let body = null;
  const rewrite = createRewriter(req.method, req.url);
  // Only creates and builds need proxy settings; other calls skip the settings read.
  const proxies = req.method === 'POST' ? containerProxyConfig((await settings()).proxy) : null;
  const route = rewriteBuildUrl(req.url, proxies);
  if (rewrite)
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw Error('Docker 요청 본문이 너무 큽니다.');
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      body = Buffer.from(text ? JSON.stringify(rewrite(JSON.parse(text), proxies)) : '');
      headers['content-length'] = String(body.length);
      delete headers['transfer-encoding'];
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: e.message }));
      return;
    }
  const upstream = http.request(
    { agent: engineAgent, method: req.method, path: route, headers, setHost: false },
    (response) => {
      res.writeHead(response.statusCode, response.statusMessage, response.rawHeaders);
      // Long polls such as wait send headers first; the CLI blocks until it sees them.
      res.flushHeaders();
      response.pipe(res);
      response.on('error', () => res.destroy());
    },
  );
  upstream.on('error', (e) => {
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Naru 엔진 연결 실패: ' + e.message }));
    }
  });
  // Streaming calls such as logs --follow end when the client leaves.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const upstream = naruSocket();
  let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  upstream.write(raw + '\r\n');
  if (head?.length) upstream.write(head);
  socket.pipe(upstream).pipe(socket);
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}
// Serves the Docker pipe to the engine.
export function startDockerBridge(pipe = NARU_PIPE, { compat = false } = {}) {
  // Clients half-close after sending stdin (docker exec -i); the reply must still flow back.
  const server = net.createServer({ allowHalfOpen: true }, async (socket) => {
    try {
      await requireReady();
    } catch {
      socket.destroy();
      return;
    }
    if (socket.destroyed) return;
    engineProxy.emit('connection', socket);
  });
  server.on('error', (e) => console.error(`Docker named pipe bridge (${pipe}): ${e.message}`));
  server.listen(pipe);
  return server;
}

// Serves the default Windows docker_engine pipe when available.
export function startCompatBridge() {
  let server;
  const attempt = async () => {
    if (server?.listening) return;
    server?.close();
    server = startDockerBridge(DOCKER_PIPE, { compat: true });
  };
  attempt();
  setInterval(attempt, 30000).unref();
}

export function startKubernetesBridge(port) {
  const sockets = new Set();
  const server = net.createServer(async (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // The relay is a plain TCP hop; the wsl.exe fallback spawns a process for every connection.
    if (pipeRelay(socket, port)) return;
    try {
      await requireReady();
    } catch {
      socket.destroy();
      return;
    }
    if (socket.destroyed) return;
    const child = spawn(
      'wsl.exe',
      ['-d', DISTRO, '-u', 'root', '--exec', 'socat', '-', `TCP:127.0.0.1:${port}`],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stderr.on('data', () => {});
    child.on('error', () => socket.destroy());
    child.stdin.on('error', () => socket.destroy());
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    socket.on('error', () => killProcess(child));
    socket.on('close', () => killProcess(child));
    child.on('close', () => socket.destroy());
  });
  server.stop = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  server.on('error', (e) => console.error(`Kubernetes localhost bridge (${port}): ${e.message}`));
  server.listen(port, '127.0.0.1');
  return server;
}
