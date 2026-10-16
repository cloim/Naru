import { requireManaged } from './external.js';
import { createServer as createHttpServer } from 'node:http';
import { registerTerminal } from './terminal.js';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ROOT, DATA, settings, saveSettings, readJSON, atomicJSON } from './state.js';
import { security, loadRemote } from './security.js';
import { jobList, submit, identifier, reconcileJobs } from './jobs.js';
import * as runtime from './runtime.js';
import * as engine from './engine.js';
import { wsl, distributions } from './runner.js';
import { startDockerBridge, startCompatBridge, startKubernetesBridge } from './bridge.js';
import { listForwards } from './forwarding.js';
import { registerExtensions } from './extensions.js';

const port = Number(process.env.PORT || 49170),
  token = randomBytes(32).toString('hex');
const remote = loadRemote(path.join(DATA, 'remote.json'));
const app = express();
const server = createHttpServer(app);
let kubernetesBridge;
engine.enableDockerPool();
app.disable('x-powered-by');
app.use(security(port, token, remote));
app.use(express.json({ limit: '2mb' }));
const cache = new Map();
async function cached(key, fn, ttl = 3000) {
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
app.get('/api/status', async (req, res) => res.json(await cached('status', runtime.status)));
app.get('/api/settings', async (req, res) => res.json(await settings()));
app.put('/api/settings', async (req, res) => {
  const current = await runtime.status();
  if (current.managed && current.running)
    throw new Error('설정을 변경하려면 Naru 런타임을 종료해 주세요.');
  const value = await saveSettings(req.body);
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
  res.json(jobs);
});
app.get('/api/jobs/:id', async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  await reconcileJobs();
  const current = await readJSON(path.join(DATA, 'jobs', `${id}.json`));
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
app.get('/api/kubernetes', async (req, res) => {
  await requireManaged();
  await runtime.requireReady();
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
app.get('/api/compose', async (req, res) => {
  const dir = path.join(
    DATA,
    (await settings()).connection === 'external-engine' ? 'compose-shared' : 'compose',
  );
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  res.json(
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => ({
          name: e.name,
          yaml: await fs.readFile(path.join(dir, e.name, 'compose.yaml'), 'utf8'),
        })),
    ),
  );
});
registerExtensions(app, port);
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
