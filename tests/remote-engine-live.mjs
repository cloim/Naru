// Usage: node tests/remote-engine-live.mjs <SSH alias> [base URL]
// Creates uniquely named test resources and removes them in finally.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
const host = process.argv[2];
if (!host) throw new Error('SSH host alias is required');
const base = process.argv[3] || 'http://127.0.0.1:49170';
const { token } = await fetch(base + '/api/session').then((r) => r.json());
let profile;
async function api(route, body, method) {
  const response = await fetch(base + '/api' + route, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      'X-Naru-Token': token,
      ...(profile
        ? { 'X-Naru-Engine': profile.id, 'X-Naru-Engine-Revision': profile.revision }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${route}: ${value.error}`);
  return value;
}
async function job(type, payload, onQueued) {
  const j = await api('/jobs', { type, payload });
  assert.equal(j.engineId, profile.id);
  assert.equal(j.target.host, host);
  await onQueued?.();
  for (let i = 0; i < 240; i++) {
    const result = await api('/jobs/' + j.id);
    if (result.job.state === 'succeeded') return result;
    if (result.job.state === 'failed') throw new Error(result.log || result.job.error);
    await delay(500);
  }
  throw new Error(`Job timeout: ${j.id}`);
}
const before = await api('/engines');
const name = 'engine-test-' + Date.now();
let container,
  composeDown = false,
  composeSaved = false,
  imageExisted = true;
const checks = [];
try {
  const input = { name, host, user: '', port: null, identityFile: '' };
  profile = await api('/engines', input);
  assert.equal((await api('/engines/test', input)).ok, true);
  assert.equal((await api('/status')).ready, true);
  checks.push('SSH profile and Docker API health');
  for (const kind of ['containers', 'images', 'volumes', 'networks']) await api('/' + kind);
  imageExisted = (await api('/images')).some((i) => i.RepoTags?.includes('alpine:latest'));
  await job('pullImage', { image: 'alpine:latest' });
  await job('createVolume', { name });
  await job('createNetwork', { name });
  await job(
    'createContainer',
    { name, image: 'alpine:latest', command: ['sh', '-c', 'echo remote-engine-ready; sleep 600'] },
    () => api('/engines/selection/current', { id: 'local' }, 'PUT'),
  );
  container = (await api('/containers')).find((c) => c.Names.includes('/' + name));
  assert.ok(container, 'queued job kept the remote target after selection changed');
  checks.push('pinned background worker, image pull, container, volume and network');
  assert.ok((await api(`/containers/${container.Id}/logs`)).text.includes('remote-engine-ready'));
  assert.equal(
    (await api(`/containers/${container.Id}/exec`, { args: ['printf', 'remote-exec-ok'] })).text,
    'remote-exec-ok',
  );
  const ticket = await api(`/containers/${container.Id}/terminal`, { shell: '/bin/sh' });
  await api(`/engines/${profile.id}`, { ...input, name: name + '-edited' }, 'PUT');
  await assert.rejects(api('/containers'), /연결 설정/);
  profile = (await api('/engines')).profiles.find((p) => p.id === profile.id);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(ticket.url, { origin: base });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('terminal timeout'));
    }, 20000);
    let output = '';
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text.includes('"type":"error"')) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(text));
        return;
      }
      if (text.includes('"type":"ready"')) {
        ws.send(JSON.stringify({ type: 'resize', cols: 93, rows: 28 }));
        ws.send(JSON.stringify({ type: 'input', data: "printf '\\nterminal-%s\\n' verified\n" }));
      } else output += text;
      if (output.includes('terminal-verified')) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
  });
  checks.push('logs, exec, terminal ticket pinning, resize and stale revision rejection');
  const yaml = 'services:\n  test:\n    image: alpine:latest\n    command: ["sleep", "600"]\n';
  composeSaved = true;
  await job('compose', { name, yaml, action: 'up' });
  assert.ok((await api('/projects')).some((p) => p.name === name && p.managed));
  assert.equal((await api(`/projects/${name}/files`)).files[0].text, yaml);
  await job('project', { name, action: 'down' });
  composeDown = true;
  checks.push('remote Compose up, saved files, project discovery and down');
  const old = profile;
  profile = null;
  assert.ok(!(await api('/containers')).some((c) => c.Names?.includes('/' + name)));
  assert.ok(!(await api('/jobs')).some((j) => j.engineId === old.id));
  assert.ok(!(await api('/projects')).some((p) => p.name === name));
  profile = old;
  checks.push('local containers, jobs and Compose registry isolation');
} catch (e) {
  console.error('Primary failure:', e.stack);
  throw e;
} finally {
  if (profile) {
    // Each cleanup targets only this run's unique names.
    if (composeSaved) {
      if (!composeDown) await job('project', { name, action: 'down' });
      await api(`/projects/${name}`, undefined, 'DELETE');
    }
    container ||= (await api('/containers')).find((c) => c.Names?.includes('/' + name));
    if (container) {
      await job('containerAction', { id: container.Id, action: 'stop' });
      await job('containerAction', { id: container.Id, action: 'remove' });
    }
    await job('removeVolume', { name });
    await job('removeNetwork', { id: name });
    if (!imageExisted) await job('removeImage', { id: 'alpine:latest' });
    await api('/engines/selection/current', { id: before.selected }, 'PUT');
    await api(`/engines/${profile.id}`, undefined, 'DELETE');
  }
}
console.log(JSON.stringify({ passed: checks.length, checks, cleanup: 'complete' }, null, 2));
