import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:49170';
const { token } = await fetch(base + '/api/session').then((r) => r.json());
const checks = [];
async function api(route, body) {
  const r = await fetch(base + '/api' + route, {
    method: body ? 'POST' : 'GET',
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
  for (let i = 0; i < 1000; i++) {
    const s = await api('/jobs/' + j.id);
    if (s.job.state === 'failed') throw new Error(s.log);
    if (s.job.state === 'succeeded') {
      console.log('PASS', type);
      checks.push(type);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout');
}
try {
  await job('startKubernetes');
  const nodes = await api('/kubernetes?kind=nodes');
  assert.ok(nodes.items.length > 0);
  checks.push('Kubernetes nodes');
  await job('kubeApply', {
    yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: naru-verification\n  namespace: default\ndata:\n  verified: "true"\n',
  });
  const maps = await api('/kubernetes?kind=configmaps');
  assert.ok(maps.items.some((x) => x.metadata.name === 'naru-verification'));
  checks.push('apply and read ConfigMap');
  await job('kubeDelete', { kind: 'configmaps', name: 'naru-verification', namespace: 'default' });
  const r = await fetch(base + '/api/kubeconfig', { headers: { 'X-Naru-Token': token } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /127.0.0.1:6445/);
  checks.push('kubeconfig export');
  console.log('ALL PASS');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    'evidence/kubernetes.json',
    JSON.stringify(
      { at: new Date().toISOString(), passed: process.exitCode !== 1, checks },
      null,
      2,
    ),
  );
}
