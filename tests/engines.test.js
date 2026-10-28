import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-profiles-'));
process.env.NARU_DATA_DIR = dir;
const { registerConnections } = await import('../server/connection-routes.js');
const { engineContext, target } = await import('../server/engine-context.js');
const { sshArgs, shellQuote } = await import('../server/connections.js');
const { settings, atomicJSON } = await import('../server/state.js');
const { assertJobTarget } = await import('../server/jobs.js');
const projects = await import('../server/projects.js');
const { wsl } = await import('../server/runner.js');
const input = { name: 'Remote A', host: 'docker-a', user: '', port: null, identityFile: '' };
const app = express();
app.use(express.json());
registerConnections(app);
app.get('/api/probe', async (req, res) => {
  await delay(60);
  res.json({ target: target(), settings: await settings() });
});
app.use((e, req, res, next) => res.status(400).json({ error: e.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(route, { method = 'GET', body, profile } = {}) {
  const response = await fetch(base + '/api' + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(profile
        ? { 'X-Naru-Engine': profile.id, 'X-Naru-Engine-Revision': profile.revision }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
}
test.after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
});

test('profiles CRUD, selection, stale revision and in-flight request isolation', async () => {
  const a = (await request('/engines', { method: 'POST', body: input })).value;
  const b = (
    await request('/engines', {
      method: 'POST',
      body: { ...input, host: 'docker-b', name: 'Remote B' },
    })
  ).value;
  assert.equal(a.host, input.host);
  assert.notEqual(a.id, b.id);
  const pending = request('/probe', { profile: a });
  await delay(20);
  assert.equal(
    (await request('/engines/selection/current', { method: 'PUT', body: { id: b.id } })).status,
    200,
  );
  const old = await pending;
  assert.equal(old.value.target.id, a.id);
  assert.equal(old.value.target.host, 'docker-a');
  assert.equal(old.value.settings.connection, 'ssh');
  assert.equal(old.value.settings.engine, 'moby');
  assert.equal((await request('/probe', { profile: b })).value.target.id, b.id);
  assert.equal((await request('/probe')).value.target.id, 'local');
  await request(`/engines/${a.id}`, { method: 'PUT', body: { ...input, host: 'docker-c' } });
  assert.equal((await request('/probe', { profile: a })).status, 409);
  const changed = (await request('/engines')).value.profiles.find((p) => p.id === a.id);
  assert.notEqual(changed.scopeId, a.scopeId);
  await request(`/engines/${a.id}`, {
    method: 'PUT',
    body: { ...input, host: 'docker-c', name: 'Renamed' },
  });
  assert.equal(
    (await request('/engines')).value.profiles.find((p) => p.id === a.id).scopeId,
    changed.scopeId,
  );
  for (const route of [
    '/disk',
    '/settings',
    '/snapshots',
    '/kubernetes',
    '/extensions',
    '/diagnostics',
    '/volumes/data/export',
    '/volumes/data/import',
  ]) {
    assert.equal((await request(route, { profile: b })).status, 409, route);
  }
  await request(`/engines/${b.id}`, { method: 'DELETE' });
  assert.equal((await request('/engines')).value.selected, 'local');
  assert.equal((await request('/probe', { profile: b })).status, 400);
  assert.equal(
    (await request('/engines', { method: 'POST', body: { ...input, host: '-oProxyCommand=bad' } }))
      .status,
    400,
  );
  assert.equal(
    (await request('/engines', { method: 'POST', body: { ...input, port: 0 } })).status,
    400,
  );
});

test('SSH inherits config with safe overrides, fixed authentication and shell quoting', () => {
  const args = sshArgs({ ...input, id: 'a', revision: 'v1' }, [
    'docker',
    'exec',
    'app',
    'printf',
    "a'b; $(touch /tmp/unwanted)",
  ]);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(!args.includes('-p'));
  assert.ok(!args.includes('-l'));
  assert.ok(!args.includes('-i'));
  assert.deepEqual(args.slice(-3, -1), ['--', 'docker-a']);
  assert.ok(args.at(-1).includes(shellQuote("a'b; $(touch /tmp/unwanted)")));
  const override = sshArgs(
    { ...input, user: 'deploy', port: 2222, identityFile: 'C:/keys/engine key' },
    ['docker', 'info'],
  );
  assert.equal(override[override.indexOf('-l') + 1], 'deploy');
  assert.equal(override[override.indexOf('-p') + 1], '2222');
  assert.equal(override[override.indexOf('-i') + 1], 'C:/keys/engine key');
});

test('engine storage preserves local layout and isolates equal Compose names', async () => {
  await projects.saveManagedProject('sample', 'services: {}');
  assert.equal((await projects.scope()).registry, path.join(dir, 'projects.json'));
  const profiles = [
    { id: crypto.randomUUID(), ...input },
    { id: crypto.randomUUID(), ...input, host: 'docker-b' },
  ];
  await Promise.all(
    profiles.map((p, i) =>
      engineContext.run(p, async () => {
        await delay(i * 10);
        await projects.saveManagedProject('sample', `services: {}\n# engine ${i}`);
        const scope = await projects.scope();
        assert.equal(scope.registry, path.join(dir, 'engines', p.id, 'projects.json'));
        const files = await projects.listProjects([]);
        assert.equal(files.length, 1);
        assert.equal(
          (await projects.readProjectFiles(files[0]))[0].text,
          `services: {}\n# engine ${i}`,
        );
        await projects.forgetProject('sample', []);
      }),
    ),
  );
  assert.equal(
    await fs.readFile(path.join(dir, 'compose/sample/compose.yaml'), 'utf8'),
    'services: {}',
  );
});

test('remote work rejects WSL operations and restricts local-only jobs', async () => {
  await atomicJSON(path.join(dir, 'settings.json'), { engine: 'containerd' });
  await engineContext.run({ id: crypto.randomUUID(), ...input }, async () => {
    await assert.rejects(wsl(['true']), /로컬 WSL/);
    for (const job of [
      'snapshot',
      'startRuntime',
      'scanImage',
      'installCLI',
      'buildImage',
      'registryLogin',
    ])
      assert.throws(() => assertJobTarget(job), /로컬 WSL/);
    for (const job of ['compose', 'containerAction', 'pruneResources', 'createContainer'])
      assertJobTarget(job);
    assert.equal((await settings()).engine, 'moby');
  });
  assert.equal((await settings()).engine, 'containerd');
});
