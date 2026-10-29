import { registerConnections } from './connection-routes.js';
import { target, engineKey } from './engine-context.js';
import { requireManaged } from './runtime.js';
import http, { createServer as createHttpServer } from 'node:http';
import { registerTerminal } from './terminal.js';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  ROOT,
  DATA,
  DISTRO,
  settings,
  saveSettings,
  settingsSchema,
  engineSettingsChanged,
  readJSON,
  atomicJSON,
} from './state.js';
import { security, loadRemote } from './security.js';
import { jobList, submit, identifier, reconcileJobs } from './jobs.js';
import * as runtime from './runtime.js';
import * as engine from './engine.js';
import { resourceSample } from './diagnostics.js';
import { wsl, distributions } from './runner.js';
import { startDockerBridge, startCompatBridge, startKubernetesBridge } from './bridge.js';
import { listForwards } from './forwarding.js';
import { startPortForwarding, portForwardingStatus } from './ports.js';
import { syncCliProxies } from './tools.js';
import { diskUsage, MIN_RECLAIM } from './disk.js';
import { registerExtensions } from './extensions.js';
import {
  LABEL,
  projectName,
  listProjects,
  findProject,
  forgetProject,
  readProjectFiles,
} from './projects.js';

const port = Number(process.env.PORT || 49170),
  token = randomBytes(32).toString('hex');
const remote = loadRemote(path.join(DATA, 'remote.json'));
const app = express();
const server = createHttpServer(app);
let kubernetesBridge;
engine.enableDockerPool();
app.disable('x-powered-by');

// *.localhost 가상 도메인 자동 리버스 프록시
app.use(async (req, res, next) => {
  const host = String(req.headers.host || '');
  const match = host.match(/^([a-zA-Z0-9_-]+)\.(?:naru\.)?localhost(?::\d+)?$/);
  if (!match) return next();
  const targetSubdomain = match[1].toLowerCase();
  if (['naru', 'www', 'app', 'localhost'].includes(targetSubdomain)) return next();
  try {
    const list = await engine.list('containers');
    const container = (list || []).find((c) => {
      const name = (c.Names?.[0] || c.Id || '').replace(/^\//, '').toLowerCase();
      return name === targetSubdomain;
    });
    const publicPort = container?.Ports?.find((p) => p.PublicPort)?.PublicPort;
    if (!publicPort) {
      return res.status(502).send(`
        <!DOCTYPE html>
        <html>
          <head><meta charset="utf-8"><title>Naru - Container Proxy</title></head>
          <body style="font-family:sans-serif;padding:40px;text-align:center;color:#333;">
            <h2>컨테이너 프록시 연결 안내</h2>
            <p>'<strong>${targetSubdomain}</strong>' 컨테이너가 실행 중이지 않거나 공개된 포트가 없습니다.</p>
            <p><a href="http://127.0.0.1:${port}">Naru 대시보드로 이동</a></p>
          </body>
        </html>
      `);
    }
    const headers = { ...req.headers, host: `127.0.0.1:${publicPort}` };
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: publicPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      res.status(502).send(`컨테이너 프록시 오류: ${err.message}`);
    });
    req.pipe(proxyReq);
  } catch {
    next();
  }
});

app.use(security(port, token, remote));
app.use(express.json({ limit: '2mb' }));
registerConnections(app);
const cache = new Map();
async function cached(key, fn, ttl = 3000) {
  key = JSON.stringify(target()) + ':' + key;
  const now = Date.now(),
    prev = cache.get(key);
  if (prev && prev.until > now) return prev.promise;
  const promise = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { until: now + ttl, promise });
  return promise;
}
app.get('/api/session', (req, res) => res.json({ token }));
app.get('/api/forwards', async (req, res) => res.json(await listForwards()));
app.get('/api/port-forwarding', (req, res) => res.json(portForwardingStatus()));
app.get('/api/status', async (req, res) => res.json(await cached('status', runtime.status)));
app.get('/api/disk', async (req, res) =>
  res.json({ ...(await cached('disk', diskUsage, 30000)), minReclaim: MIN_RECLAIM }),
);
app.get('/api/settings', async (req, res) => res.json(await settings()));
app.put('/api/settings', async (req, res) => {
  const current = await runtime.status();
  if (
    current.managed &&
    current.running &&
    engineSettingsChanged(await settings(), settingsSchema.parse(req.body))
  )
    throw new Error('엔진 설정을 변경하려면 Naru 런타임을 종료해 주세요.');
  const value = await saveSettings(req.body);
  await syncCliProxies();
  if (current.kubernetes.port !== value.kubernetes.port) {
    kubernetesBridge?.stop();
    kubernetesBridge = startKubernetesBridge(value.kubernetes.port);
  }
  cache.clear();
  res.json(value);
});
for (const kind of ['containers', 'images', 'volumes', 'networks']) {
  app.get(`/api/${kind}`, async (req, res) =>
    res.json(await cached(kind, () => engine.list(kind))),
  );
  app.get(`/api/${kind}/:id/inspect`, async (req, res) =>
    res.json(await engine.inspect(kind, identifier.parse(req.params.id))),
  );
}
app.get('/api/:kind/prune-preview', async (req, res) => {
  const kind = req.params.kind;
  if (!['images', 'volumes', 'networks'].includes(kind)) {
    return res.status(400).json({ error: '지원하지 않는 리소스 종류입니다.' });
  }
  res.json(await engine.getPrunePreview(kind));
});
app.get('/api/containers/:id/logs', async (req, res) =>
  res.json({ text: await engine.logs(identifier.parse(req.params.id)) }),
);
app.post('/api/containers/:id/exec', async (req, res) => {
  const p = z
    .object({ args: z.array(z.string().max(4096)).min(1).max(100) })
    .strict()
    .parse(req.body);
  const output = await engine.cli(['exec', identifier.parse(req.params.id), ...p.args], {
    timeout: 30000,
    fullResult: true,
  });
  res.json({ text: output.stdout, stderr: output.stderr, code: output.code });
});
app.get('/api/containers/:id/stats', async (req, res) => {
  await runtime.requireReady();
  const cfg = await settings();
  res.json(
    cfg.engine === 'moby'
      ? await engine.dockerRequest(
          'GET',
          `/containers/${encodeURIComponent(identifier.parse(req.params.id))}/stats?stream=false`,
        )
      : { text: await engine.cli(['stats', '--no-stream', identifier.parse(req.params.id)]) },
  );
});
app.get('/api/containers/:id/files', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const rawPath = String(req.query.path || '/');
  const targetPath = path.posix.normalize(rawPath.startsWith('/') ? rawPath : '/' + rawPath);
  try {
    const output = await engine.cli(
      [
        'exec',
        id,
        'sh',
        '-c',
        `ls -la --time-style=long-iso "${targetPath}" 2>/dev/null || ls -la "${targetPath}"`,
      ],
      { timeout: 15000 },
    );
    const lines = output.split(/\r?\n/).filter(Boolean);
    const entries = [];
    for (const line of lines) {
      if (line.startsWith('total')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) continue;
      const mode = parts[0];
      const isDir = mode.startsWith('d');
      const name = parts.slice(mode.length > 0 && parts[5]?.includes('-') ? 7 : 8).join(' ');
      if (!name || name === '.' || name === '..') continue;
      const size = Number(parts[4]) || 0;
      entries.push({
        name,
        path: path.posix.join(targetPath, name),
        isDir,
        size,
        mode,
      });
    }
    entries.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));
    res.json({ path: targetPath, entries });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.get('/api/containers/:id/files/content', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const targetPath = path.posix.normalize(String(req.query.path || ''));
  if (!targetPath || targetPath === '/') throw new Error('파일 경로를 지정해 주세요.');
  try {
    const text = await engine.cli(['exec', id, 'sh', '-c', `cat "${targetPath}"`], {
      timeout: 15000,
    });
    res.json({ path: targetPath, text });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.put('/api/containers/:id/files/content', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const p = z
    .object({
      path: z.string().min(1).max(4096),
      text: z.string().max(10 * 1024 * 1024),
    })
    .strict()
    .parse(req.body);
  const targetPath = path.posix.normalize(p.path);
  try {
    await engine.cli(['exec', '-i', id, 'sh', '-c', `cat > "${targetPath}"`], {
      input: p.text,
      timeout: 15000,
    });
    res.json({ ok: true, path: targetPath });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.delete('/api/containers/:id/files', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const targetPath = path.posix.normalize(String(req.query.path || ''));
  if (!targetPath || targetPath === '/') throw new Error('루트 디렉터리는 삭제할 수 없습니다.');
  try {
    await engine.cli(['exec', id, 'sh', '-c', `rm -rf "${targetPath}"`], { timeout: 15000 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.get('/api/volumes/:id/files', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const vol = await engine.inspect('volumes', id);
  const mountpoint = vol?.Mountpoint;
  if (!mountpoint) throw new Error('볼륨 마운트 경로를 찾을 수 없습니다.');
  const rawPath = String(req.query.path || '/');
  const targetRel = path.posix.normalize(rawPath.startsWith('/') ? rawPath.slice(1) : rawPath);
  const targetDir = path.posix.join(mountpoint, targetRel);
  if (!targetDir.startsWith(mountpoint)) throw new Error('잘못된 접근 경로입니다.');
  try {
    const output = await wsl(
      [
        'sh',
        '-c',
        `ls -la --time-style=long-iso "${targetDir}" 2>/dev/null || ls -la "${targetDir}"`,
      ],
      { timeout: 15000 },
    );
    const lines = output.split(/\r?\n/).filter(Boolean);
    const entries = [];
    for (const line of lines) {
      if (line.startsWith('total')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) continue;
      const mode = parts[0];
      const isDir = mode.startsWith('d');
      const name = parts.slice(mode.length > 0 && parts[5]?.includes('-') ? 7 : 8).join(' ');
      if (!name || name === '.' || name === '..') continue;
      const size = Number(parts[4]) || 0;
      entries.push({
        name,
        path: path.posix.join('/' + targetRel, name),
        isDir,
        size,
        mode,
      });
    }
    entries.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));
    res.json({ path: '/' + targetRel, entries });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.get('/api/volumes/:id/files/content', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const vol = await engine.inspect('volumes', id);
  const mountpoint = vol?.Mountpoint;
  if (!mountpoint) throw new Error('볼륨 마운트 경로를 찾을 수 없습니다.');
  const rawPath = String(req.query.path || '');
  const targetRel = path.posix.normalize(rawPath.startsWith('/') ? rawPath.slice(1) : rawPath);
  const targetPath = path.posix.join(mountpoint, targetRel);
  if (!targetPath.startsWith(mountpoint)) throw new Error('잘못된 접근 경로입니다.');
  try {
    const text = await wsl(['cat', targetPath], { timeout: 15000 });
    res.json({ path: '/' + targetRel, text });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.put('/api/volumes/:id/files/content', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const vol = await engine.inspect('volumes', id);
  const mountpoint = vol?.Mountpoint;
  if (!mountpoint) throw new Error('볼륨 마운트 경로를 찾을 수 없습니다.');
  const p = z
    .object({
      path: z.string().min(1).max(4096),
      text: z.string().max(10 * 1024 * 1024),
    })
    .strict()
    .parse(req.body);
  const targetRel = path.posix.normalize(p.path.startsWith('/') ? p.path.slice(1) : p.path);
  const targetPath = path.posix.join(mountpoint, targetRel);
  if (!targetPath.startsWith(mountpoint)) throw new Error('잘못된 접근 경로입니다.');
  try {
    await wsl(['sh', '-c', `cat > "${targetPath}"`], { input: p.text, timeout: 15000 });
    res.json({ ok: true, path: '/' + targetRel });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.delete('/api/volumes/:id/files', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const vol = await engine.inspect('volumes', id);
  const mountpoint = vol?.Mountpoint;
  if (!mountpoint) throw new Error('볼륨 마운트 경로를 찾을 수 없습니다.');
  const rawPath = String(req.query.path || '');
  const targetRel = path.posix.normalize(rawPath.startsWith('/') ? rawPath.slice(1) : rawPath);
  if (!targetRel || targetRel === '.' || targetRel === '/')
    throw new Error('루트 디렉터리는 삭제할 수 없습니다.');
  const targetPath = path.posix.join(mountpoint, targetRel);
  if (!targetPath.startsWith(mountpoint)) throw new Error('잘못된 접근 경로입니다.');
  try {
    await wsl(['rm', '-rf', targetPath], { timeout: 15000 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.get('/api/volumes/:id/export', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const vol = await engine.inspect('volumes', id);
  const mountpoint = vol?.Mountpoint;
  if (!mountpoint) throw new Error('볼륨 마운트 경로를 찾을 수 없습니다.');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(id)}.tar.gz"`);
  const child = spawn(
    'wsl.exe',
    [
      '--distribution',
      DISTRO,
      '--user',
      'root',
      '--exec',
      'tar',
      '-czf',
      '-',
      '-C',
      mountpoint,
      '.',
    ],
    { windowsHide: true },
  );
  child.stdout.pipe(res);
  child.on('error', (err) => {
    if (!res.headersSent) res.status(500).send(err.message);
  });
});
app.post(
  '/api/volumes/:id/import',
  express.raw({ type: '*/*', limit: '500mb' }),
  async (req, res) => {
    const id = identifier.parse(req.params.id);
    const vol = await engine.inspect('volumes', id);
    const mountpoint = vol?.Mountpoint;
    if (!mountpoint) throw new Error('볼륨 마운트 경로를 찾을 수 없습니다.');
    const child = spawn(
      'wsl.exe',
      ['--distribution', DISTRO, '--user', 'root', '--exec', 'tar', '-xzf', '-', '-C', mountpoint],
      { windowsHide: true },
    );
    child.stdin.end(req.body);
    child.on('close', (code) => {
      if (code === 0) res.json({ ok: true });
      else res.status(500).json({ message: `복원 실패 (exit code ${code})` });
    });
    child.on('error', (err) => res.status(500).json({ message: err.message }));
  },
);
app.get('/api/images/:id/history', async (req, res) => {
  const id = identifier.parse(req.params.id);
  const cfg = await settings();
  try {
    if (cfg.engine === 'moby') {
      const list = await engine.dockerRequest('GET', `/images/${encodeURIComponent(id)}/history`);
      return res.json(list);
    }
    const lines = await engine.cli(['history', '--no-trunc', '--format', '{{json .}}', id]);
    const parsed = lines
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.post('/api/networks/ping', async (req, res) => {
  const p = z
    .object({
      source: identifier,
      target: z.string().min(1).max(512),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .strict()
    .parse(req.body);
  try {
    const cmd = p.port
      ? `nc -zv -w 2 "${p.target}" ${p.port} 2>&1 || timeout 2 bash -c "</dev/tcp/${p.target}/${p.port}" 2>&1`
      : `ping -c 2 -W 2 "${p.target}" 2>&1 || getent hosts "${p.target}" 2>&1`;
    const output = await engine.cli(['exec', p.source, 'sh', '-c', cmd], {
      timeout: 10000,
      fullResult: true,
    });
    res.json({
      ok: output.code === 0,
      output: output.stdout || output.stderr,
      code: output.code,
    });
  } catch (e) {
    res.status(500).json({ ok: false, output: e.message });
  }
});
let completedJobs = '';
app.get('/api/jobs', async (req, res) => {
  await reconcileJobs();
  const jobs = await jobList();
  const finished = jobs
    .filter((j) => ['failed', 'succeeded'].includes(j.state))
    .map((j) => j.id)
    .join(',');
  if (completedJobs !== finished) {
    completedJobs = finished;
    cache.clear();
  }
  res.json(jobs.filter((j) => (j.engineScopeId || j.engineId || 'local') === engineKey()));
});
app.get('/api/jobs/:id', async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  await reconcileJobs();
  const current = await readJSON(path.join(DATA, 'jobs', `${id}.json`));
  if ((current.engineScopeId || current.engineId || 'local') !== engineKey())
    throw new Error('다른 엔진의 작업입니다.');
  if (['succeeded', 'failed'].includes(current.state)) cache.clear();
  res.json({
    job: await readJSON(path.join(DATA, 'jobs', `${id}.json`)),
    log: await fs.readFile(path.join(DATA, 'jobs', `${id}.log`), 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return '';
      throw e;
    }),
  });
});
app.post('/api/jobs', async (req, res) => {
  const p = z
    .object({ type: z.string(), payload: z.record(z.string(), z.unknown()).default({}) })
    .strict()
    .parse(req.body);
  res.status(202).json(await submit(p.type, p.payload));
  cache.clear();
});
async function kubernetesRunning() {
  try {
    await wsl(['sh', '-c', 'test -f /run/naru/k3s.pid && kill -0 "$(cat /run/naru/k3s.pid)"'], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
app.get('/api/kubernetes/state', async (req, res) => {
  await requireManaged();
  await runtime.requireReady();
  res.json({ running: await cached('kube:state', kubernetesRunning) });
});
app.get('/api/kubernetes', async (req, res) => {
  await requireManaged();
  await runtime.requireReady();
  if (!(await cached('kube:state', kubernetesRunning)))
    throw new Error('Kubernetes가 꺼져 있습니다. 상단의 Kubernetes 시작으로 실행해 주세요.');
  const kind = z
    .enum([
      'pods',
      'deployments',
      'services',
      'nodes',
      'namespaces',
      'configmaps',
      'persistentvolumeclaims',
      'events',
    ])
    .parse(req.query.kind || 'pods');
  const args = [
    '/usr/local/bin/naru-netns',
    '/usr/local/bin/k3s',
    'kubectl',
    '--kubeconfig',
    '/etc/naru/kubeconfig',
    'get',
    kind,
    '-o',
    'json',
  ];
  if (!['nodes', 'namespaces'].includes(kind)) args.push('-A');
  res.json(
    await cached('kube:' + kind, async () => JSON.parse(await wsl(args, { timeout: 10000 }))),
  );
});
app.get('/api/kubernetes/logs', async (req, res) => {
  await requireManaged();
  await runtime.requireReady();
  const p = z
    .object({
      name: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/),
      namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    })
    .parse(req.query);
  res.json({
    text: await wsl(
      [
        '/usr/local/bin/naru-netns',
        '/usr/local/bin/k3s',
        'kubectl',
        '--kubeconfig',
        '/etc/naru/kubeconfig',
        '-n',
        p.namespace,
        'logs',
        p.name,
        '--all-containers=true',
        '--tail=300',
      ],
      { timeout: 15000 },
    ),
  });
});
app.get('/api/kubeconfig', async (req, res) => {
  const text = await runtime.exportKubeconfig();
  res
    .type('text/yaml')
    .setHeader('Content-Disposition', 'attachment; filename="naru-kubeconfig.yaml"');
  res.send(text);
});
app.get('/api/snapshots', async (req, res) => {
  const dir = path.join(DATA, 'snapshots');
  await fs.mkdir(dir, { recursive: true });
  res.json(
    await Promise.all(
      (await fs.readdir(dir))
        .filter((x) => x.endsWith('.json'))
        .map((x) => readJSON(path.join(dir, x))),
    ),
  );
});
const projectContainers = async () => {
  await runtime.requireReady();
  return engine.list('containers');
};
app.get('/api/projects', async (req, res) =>
  res.json(await cached('projects', async () => listProjects(await projectContainers()))),
);
app.get('/api/projects/:name/files', async (req, res) => {
  const project = await findProject(projectName.parse(req.params.name), await projectContainers());
  res.json({ ...project, files: await readProjectFiles(project) });
});
app.get('/api/projects/:name/logs', async (req, res) => {
  const name = projectName.parse(req.params.name);
  const members = (await projectContainers()).filter((c) => c.Labels?.[LABEL.project] === name);
  const sections = await Promise.all(
    members.map(async (c) => {
      const service = c.Labels[LABEL.service] || containerLabel(c);
      const text = await engine.logs(c.Id, 200).catch((e) => e.message);
      return `== ${service} (${containerLabel(c)}) ==\n${text || '아직 출력된 로그가 없습니다.'}`;
    }),
  );
  res.json({ text: sections.join('\n\n') });
});
app.delete('/api/projects/:name', async (req, res) => {
  await forgetProject(projectName.parse(req.params.name), await projectContainers());
  cache.delete('projects');
  res.json({ ok: true });
});
const containerLabel = (c) => (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, '');
registerExtensions(app, port);
app.get('/api/diagnostics/resources', async (req, res) => res.json(await resourceSample()));
app.get('/api/diagnostics', async (req, res) => {
  const state = await runtime.status();
  const logs = {};
  if (state.running && state.managed)
    for (const name of ['engine', 'kubernetes', 'buildkit'])
      logs[name] = await wsl([
        'sh',
        '-c',
        `tail -n 100 /var/log/naru/${name}.log 2>/dev/null || true`,
      ]);
  res.json({
    state,
    distributions: await distributions(),
    provenance: await readJSON(path.join(DATA, 'provenance.json'), null),
    logs,
    node: process.version,
    memory: process.memoryUsage(),
    uptime: process.uptime(),
  });
});
registerTerminal(app, server, port, remote);
app.use('/api', (req, res) => res.status(404).json({ error: 'API 경로를 확인해 주세요.' }));
if (process.env.NARU_DEV === '1') {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(ROOT, 'dist')));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));
}
app.use((err, req, res, next) => {
  console.error(err.message);
  const invalid = err instanceof z.ZodError;
  res.status(invalid ? 400 : err.code === 'ENOENT' ? 404 : 500).json({
    error: invalid
      ? err.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('\n')
      : err.message,
  });
});

await fs.mkdir(DATA, { recursive: true });
// An interrupted worker is reported as failed instead of remaining busy forever.
for (const job of await jobList())
  if (['running', 'queued'].includes(job.state)) {
    let alive = false;
    if (job.pid)
      try {
        process.kill(job.pid, 0);
        alive = true;
      } catch {}
    if (!alive)
      await atomicJSON(path.join(DATA, 'jobs', `${job.id}.json`), {
        ...job,
        state: 'failed',
        error: '이전 작업 프로세스가 종료되었습니다.',
        finishedAt: new Date().toISOString(),
      });
  }
try {
  const pid = Number(await fs.readFile(path.join(DATA, 'runtime.lock'), 'utf8'));
  try {
    process.kill(pid, 0);
  } catch {
    await fs.unlink(path.join(DATA, 'runtime.lock'));
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Naru http://127.0.0.1:${port} | ${DATA}${remote ? ` | https://${remote.host}` : ''}`,
  ),
);
if (process.platform === 'win32') {
  startDockerBridge();
  startCompatBridge();
  startPortForwarding();
}
kubernetesBridge = startKubernetesBridge((await settings()).kubernetes.port);
// Containers with a restart policy come back only when the engine starts with the server.
if ((await settings()).autoStart)
  runtime
    .status()
    .then((s) => (s.managed && s.installed && !s.running ? submit('startRuntime', {}) : null))
    .catch((e) => console.error(`엔진 자동 시작: ${e.message}`));
server.on('error', (e) => {
  console.error(e);
  process.exitCode = 1;
});
