import { settings } from './state.js';
import { RANCHER_PIPE } from './external.js';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DISTRO } from './state.js';
import { requireReady } from './runtime.js';

export function startDockerBridge() {
  const server = net.createServer(async (socket) => {
    try {
      await requireReady();
    } catch {
      socket.destroy();
      return;
    }
    if (socket.destroyed) return;
    if ((await settings()).connection === 'rancher-desktop') {
      const upstream = net.connect(RANCHER_PIPE);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
      return;
    }
    const child = spawn(
      'wsl.exe',
      ['-d', DISTRO, '-u', 'root', '--exec', 'socat', '-', 'UNIX-CONNECT:/run/naru/docker.sock'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stderr.on('data', () => {});
    child.on('error', () => socket.destroy());
    child.stdin.on('error', () => socket.destroy());
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    socket.on('error', () => child.kill());
    socket.on('close', () => child.kill());
    child.on('close', () => socket.destroy());
  });
  server.on('error', (e) => console.error(`Docker named pipe bridge: ${e.message}`));
  server.listen('\\\\.\\pipe\\naru_engine');
  return server;
}

export function startKubernetesBridge(port) {
  const sockets = new Set();
  const server = net.createServer(async (socket) => {
    if ((await settings()).connection === 'rancher-desktop') {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
    socket.on('error', () => child.kill());
    socket.on('close', () => child.kill());
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
