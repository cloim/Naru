import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const base = 'http://127.0.0.1:49170';
const { token } = await fetch(base + '/api/session').then((r) => r.json());
const checks = [];
async function api(route, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + '/api' + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Naru-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}
async function job(type, payload = {}) {
  console.log('START', type);
  const j = await api('/jobs', { type, payload });
  for (let i = 0; i < 1800; i++) {
    const s = await api('/jobs/' + j.id);
    if (s.job.state === 'failed') throw new Error(s.log);
    if (s.job.state === 'succeeded') {
      console.log('PASS', type);
      checks.push(type);
      return s;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timeout ' + type);
}
const original = await api('/settings');
let switched = false;
async function waitHTTP(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Service readiness timeout: ' + url);
}
try {
  await fs.unlink(path.resolve('.local/naru-image.tar')).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  await job('compose', {
    name: 'naru-compose-verification',
    yaml: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:49283:80"\n',
    action: 'up',
  });
  assert.equal((await waitHTTP('http://127.0.0.1:49283')).status, 200);
  checks.push('Compose localhost service');
  await job('compose', {
    name: 'naru-compose-verification',
    yaml: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:49283:80"\n',
    action: 'down',
  });
  const context = path.resolve('.local/build-fixture');
  await fs.mkdir(context, { recursive: true });
  await fs.writeFile(
    path.join(context, 'Dockerfile'),
    'FROM nginx:alpine\nRUN echo built-by-naru > /proof\n',
  );
  await job('buildImage', { context, tag: 'naru-verification:local' });
  await job('exportImage', {
    image: 'naru-verification:local',
    file: path.resolve('.local/naru-image.tar'),
  });
  await job('removeImage', { id: 'naru-verification:local' });
  await job('importImage', { file: path.resolve('.local/naru-image.tar') });
  checks.push('build export remove import image');
  await job('createContainer', {
    image: 'naru-verification:local',
    name: 'naru-build-verification',
  });
  await new Promise((r) => setTimeout(r, 3500));
  const c = (await api('/containers')).find((x) => x.Names.includes('/naru-build-verification'));
  assert.match(
    (await api(`/containers/${c.Id}/exec`, { args: ['cat', '/proof'] })).text,
    /built-by-naru/,
  );
  checks.push('built image content');
  await job('containerAction', { id: c.Id, action: 'stop' });
  await job('containerAction', { id: c.Id, action: 'remove' });
  await job('kubeApply', {
    yaml: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: naru-web-verification\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: naru-web-verification\n  template:\n    metadata:\n      labels:\n        app: naru-web-verification\n    spec:\n      containers:\n        - name: web\n          image: nginx:alpine\n          imagePullPolicy: IfNotPresent\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: naru-web-verification\nspec:\n  selector:\n    app: naru-web-verification\n  ports:\n    - port: 80\n      targetPort: 80\n',
  });
  await job('createForward', {
    resource: 'svc/naru-web-verification',
    namespace: 'default',
    localPort: 49284,
    remotePort: 80,
  });
  const response = await waitHTTP('http://127.0.0.1:49284');
  assert.equal(response.status, 200);
  checks.push('Kubernetes workload and Windows port-forward');
  const f = (await api('/forwards')).find((x) => x.localPort === 49284 && x.state === 'running');
  assert.ok(f);
  await job('stopForward', { id: f.id });
  await job('removeForward', { id: f.id });
  assert.ok(!(await api('/forwards')).some((x) => x.id === f.id));
  await job('kubeDelete', { kind: 'services', name: 'naru-web-verification' });
  await job('kubeDelete', { kind: 'deployments', name: 'naru-web-verification' });
  await job('stopRuntime');
  await api('/settings', { ...original, engine: 'containerd' }, 'PUT');
  switched = true;
  await job('startRuntime');
  await job('pullImage', { image: 'alpine:3.22' });
  await job('createContainer', {
    image: 'alpine:3.22',
    name: 'naru-containerd-verification',
    command: ['sh', '-c', 'echo containerd-works; sleep 600'],
  });
  await new Promise((r) => setTimeout(r, 3500));
  const containers = await api('/containers');
  const nc = containers.find((x) => x.Names.includes('naru-containerd-verification'));
  assert.ok(nc);
  assert.match((await api(`/containers/${nc.Id}/logs`)).text, /containerd-works/);
  checks.push('containerd run list logs');
  await job('containerAction', { id: nc.Id, action: 'stop' });
  await job('containerAction', { id: nc.Id, action: 'remove' });
  await job('stopRuntime');
  await api('/settings', original, 'PUT');
  switched = false;
  await job('startRuntime');
  const snapshots = await api('/snapshots');
  await job('snapshot', { name: 'Naru 검증 스냅샷' });
  const snap = (await api('/snapshots')).find((x) => !snapshots.some((s) => s.id === x.id));
  assert.ok(snap);
  assert.ok(snap.bytes > 100000000);
  checks.push('WSL consistent snapshot export');
  await job('restoreSnapshot', { id: snap.id, confirmation: 'RESTORE' });
  await job('startRuntime');
  assert.ok((await api('/images')).some((x) => x.RepoTags?.includes('nginx:alpine')));
  checks.push('snapshot restore preserves images');
  console.log('ALL PASS');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (switched)
    try {
      await job('stopRuntime');
      await api('/settings', original, 'PUT');
      await job('startRuntime');
    } catch (e) {
      console.error('restore original engine failed:', e.message);
    }
  await fs.writeFile(
    'evidence/advanced.json',
    JSON.stringify(
      { at: new Date().toISOString(), passed: process.exitCode !== 1, checks },
      null,
      2,
    ),
  );
}
