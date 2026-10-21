import net from 'node:net';
import { PassThrough } from 'node:stream';
import { wsl } from './runner.js';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DISTRO, settings } from './state.js';
import { identifier } from './jobs.js';
import { requireReady } from './runtime.js';
import { dockerRequest } from './engine.js';
import { access } from './security.js';

export function registerTerminal(app, server, port, remote = null) {
  const tickets = new Map();
  const shellSchema = z.enum(['/bin/sh', '/bin/bash', '/bin/ash']);
  app.post('/api/containers/:id/terminal', async (req, res) => {
    await requireReady();
    const id = identifier.parse(req.params.id),
      shell = shellSchema.parse(req.body.shell || '/bin/sh'),
      cfg = await settings();
    for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
    const ticket = randomBytes(24).toString('hex');
    tickets.set(ticket, {
      id,
      shell,
      engine: cfg.engine,
      connection: cfg.connection,
      namespace: cfg.namespace,
      expires: Date.now() + 30000,
    });
    const scheme = access(req, port, remote) === 'https' ? 'wss' : 'ws';
    res.json({
      url: `${scheme}://${req.headers.host}/api/terminal?ticket=${ticket}`,
      engine: cfg.engine,
    });
  });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/terminal') {
      socket.destroy();
      return;
    }
    if (!req.headers.origin || !access(req, port, remote)) {
      socket.destroy();
      return;
    }
    const key = url.searchParams.get('ticket'),
      ticket = tickets.get(key);
    tickets.delete(key);
    if (!ticket || ticket.expires < Date.now()) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => start(ws, ticket));
  });
  async function start(ws, ticket) {
    let child,
      execId,
      connected = false,
      header = Buffer.alloc(0);
    const fail = (error) => {
      if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
      ws.close();
      child?.kill();
    };
    ws.on('error', () => child?.kill());
    ws.on('close', () => {
      child?.stdin.end();
      setTimeout(() => child?.kill(), 300).unref();
    });
    try {
      await requireReady();
      const cfg = await settings();
      if (cfg.engine !== ticket.engine || cfg.connection !== ticket.connection)
        throw new Error('엔진이 변경되었습니다. 터미널에 다시 연결해 주세요.');
      if (ticket.engine === 'containerd') {
        const tty = '/run/naru/terminal-' + randomBytes(12).toString('hex');
        const executable =
          '/usr/bin/nerdctl --address /run/naru/containerd.sock --namespace ' +
          ticket.namespace +
          ' exec -it ' +
          ticket.id +
          ' ' +
          ticket.shell;
        child = spawn(
          'wsl.exe',
          [
            '-d',
            DISTRO,
            '-u',
            'root',
            '--exec',
            'socat',
            '-',
            'EXEC:' + executable + ',pty,setsid,ctty,stderr,rawer,link=' + tty,
          ],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        child.on('error', fail);
        child.stdin.on('error', fail);
        child.stderr.on('data', () => {});
        child.on('close', () => ws.close());
        child.stdout.on('data', (data) => {
          if (ws.readyState === ws.OPEN) ws.send(data);
        });
        connected = true;
        ws.send(JSON.stringify({ type: 'ready' }));
        ws.on('message', async (raw) => {
          try {
            const data = JSON.parse(raw.toString());
            if (data.type === 'input') {
              if (typeof data.data !== 'string' || data.data.length > 65536)
                throw new Error('터미널 입력 형식을 확인해 주세요.');
              child.stdin.write(data.data);
            } else if (data.type === 'resize') {
              const cols = z.number().int().min(2).max(500).parse(data.cols),
                rows = z.number().int().min(1).max(250).parse(data.rows);
              for (let i = 0; i < 10; i++) {
                try {
                  await wsl(['stty', '-F', tty, 'cols', String(cols), 'rows', String(rows)]);
                  break;
                } catch (e) {
                  if (i === 9) throw e;
                  await new Promise((r) => setTimeout(r, 100));
                }
              }
            } else throw new Error('터미널 메시지 형식을 확인해 주세요.');
          } catch (e) {
            fail(e);
          }
        });
        ws.on('close', () => wsl(['rm', '-f', tty]).catch(() => {}));
        return;
      }
      const exec = await dockerRequest(
        'POST',
        `/containers/${encodeURIComponent(ticket.id)}/exec`,
        {
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          Cmd: [ticket.shell],
        },
      );
      execId = exec.Id;
      child = spawn(
        'wsl.exe',
          [
            '-d',
            DISTRO,
            '-u',
            'root',
            '--exec',
            'socat',
            '-',
            'UNIX-CONNECT:/run/naru/docker.sock',
          ],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stderr.on('data', () => {});
      child.on('close', () => ws.close());
      child.stdout.on('data', (chunk) => {
        if (ws.readyState !== ws.OPEN) return;
        if (!connected) {
          header = Buffer.concat([header, chunk]);
          if (header.length > 65536) return fail(new Error('터미널 HTTP 응답 헤더가 너무 큽니다.'));
          const end = header.indexOf('\r\n\r\n');
          if (end < 0) return;
          const status = Number(header.toString('ascii', 0, end).split(' ')[1]);
          if (![101, 200].includes(status))
            return fail(new Error(`터미널 연결 실패: Docker HTTP ${status}`));
          connected = true;
          ws.send(JSON.stringify({ type: 'ready' }));
          const remaining = header.subarray(end + 4);
          if (remaining.length) ws.send(remaining);
          header = Buffer.alloc(0);
        } else ws.send(chunk);
      });
      const payload = JSON.stringify({ Detach: false, Tty: true });
      child.stdin.write(
        `POST /exec/${execId}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
      );
      ws.on('message', async (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'input') {
            if (typeof data.data !== 'string' || data.data.length > 65536)
              throw new Error('터미널 입력 형식이 잘못되었습니다.');
            if (connected) child.stdin.write(data.data);
          } else if (data.type === 'resize') {
            const columns = z.number().int().min(2).max(500).parse(data.cols),
              rows = z.number().int().min(1).max(250).parse(data.rows);
            if (connected)
              await dockerRequest('POST', `/exec/${execId}/resize?h=${rows}&w=${columns}`);
          } else throw new Error('터미널 메시지 형식이 잘못되었습니다.');
        } catch (e) {
          fail(e);
        }
      });
    } catch (e) {
      fail(e);
    }
  }
}
