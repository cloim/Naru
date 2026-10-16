import test from 'node:test';
import assert from 'node:assert/strict';
import { security, access, loadRemote } from '../server/security.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateJob } from '../server/jobs.js';
import { settingsSchema } from '../server/state.js';
import { decodeDockerStream } from '../server/engine.js';

function authorize(headers, path = '/api/jobs') {
  let status = 200,
    body,
    passed = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(data) {
      body = data;
      return this;
    },
    setHeader() {},
  };
  security(49170, 'test-token')({ headers, path }, res, () => (passed = true));
  return { status, passed, body };
}
test('cross-origin requests and DNS rebinding cannot invoke privileged local API', () => {
  assert.equal(authorize({ host: 'evil.example:49170', 'x-naru-token': 'test-token' }).status, 403);
  assert.equal(
    authorize({
      host: '127.0.0.1:49170',
      origin: 'https://evil.example',
      'x-naru-token': 'test-token',
    }).status,
    403,
  );
  assert.equal(
    authorize({
      host: '127.0.0.1:49170',
      'sec-fetch-site': 'cross-site',
      'x-naru-token': 'test-token',
    }).status,
    403,
  );
});
test('API requires exact token and accepts only local same-origin request', () => {
  assert.equal(authorize({ host: '127.0.0.1:49170' }).status, 401);
  assert.equal(authorize({ host: '127.0.0.1:49170', 'x-naru-token': 'bad' }).status, 401);
  assert.equal(
    authorize({
      host: '127.0.0.1:49170',
      origin: 'http://127.0.0.1:49170',
      'x-naru-token': 'test-token',
    }).passed,
    true,
  );
});
test('Tailscale remote access requires serve host, loopback proxy and an allowed tailnet login', () => {
  const remote = { host: 'pc.tail1.ts.net:8461', users: new Set(['owner@example.com']) };
  const req = (headers, address = '127.0.0.1') => ({ headers, socket: { remoteAddress: address } });
  const ok = {
    host: 'pc.tail1.ts.net:8461',
    origin: 'https://pc.tail1.ts.net:8461',
    'tailscale-user-login': 'Owner@example.com',
  };
  assert.equal(access(req(ok), 49170, remote), 'https');
  assert.equal(access(req(ok), 49170, null), null);
  assert.equal(access(req(ok, '100.64.0.2'), 49170, remote), null);
  assert.equal(
    access(req({ ...ok, 'tailscale-user-login': 'other@example.com' }), 49170, remote),
    null,
  );
  assert.equal(access(req({ ...ok, 'tailscale-user-login': undefined }), 49170, remote), null);
  assert.equal(access(req({ ...ok, origin: 'https://evil.example' }), 49170, remote), null);
  assert.equal(access(req({ ...ok, host: 'evil.example' }), 49170, remote), null);
  assert.equal(access(req({ host: '127.0.0.1:49170' }), 49170, remote), 'http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naru-remote-'));
  const file = path.join(dir, 'remote.json');
  assert.equal(loadRemote(file), null);
  fs.writeFileSync(file, JSON.stringify({ host: 'evil.example', users: ['a@b.c'] }));
  assert.equal(loadRemote(file), null);
  fs.writeFileSync(file, JSON.stringify({ host: 'PC.tail1.ts.net:8461', users: [] }));
  assert.equal(loadRemote(file), null);
  fs.writeFileSync(
    file,
    JSON.stringify({ host: 'PC.tail1.ts.net:8461', users: ['Owner@example.com'] }),
  );
  assert.equal(loadRemote(file).host, 'pc.tail1.ts.net:8461');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('shell injection, option injection, unknown fields, path traversal rejected at boundary', () => {
  for (const image of ['--privileged', 'a; whoami', '$(whoami)', 'a\n-b'])
    assert.throws(() => validateJob('pullImage', { image }));
  assert.throws(() => validateJob('createContainer', { image: 'alpine', privileged: true }));
  assert.throws(() =>
    validateJob('buildImage', { context: 'D:/src', tag: 'app', dockerfile: '../secrets' }),
  );
  assert.throws(() =>
    validateJob('buildImage', {
      context: 'D:/src',
      tag: 'app',
      dockerfile: 'nested/../../secrets',
    }),
  );
  assert.throws(() =>
    validateJob('deleteSnapshot', { id: '../../etc/passwd', confirmation: 'DELETE' }),
  );
  assert.throws(() => validateJob('removeForward', { id: '../../etc/passwd' }));
  assert.throws(() => validateJob('unknown', {}));
});
test('destructive snapshot operations require exact explicit confirmation', () => {
  const id = '4c002b3b-1f13-4e2b-bff9-944d4adbdc3c';
  assert.throws(() => validateJob('restoreSnapshot', { id }));
  assert.throws(() => validateJob('restoreSnapshot', { id, confirmation: 'DELETE' }));
  assert.equal(validateJob('restoreSnapshot', { id, confirmation: 'RESTORE' }).id, id);
});
test('published container ports have bounded values, mounts and args preserve structured input', () => {
  assert.throws(() =>
    validateJob('createContainer', { image: 'nginx', ports: [{ host: 80, container: 80 }] }),
  );
  assert.throws(() =>
    validateJob('createContainer', { image: 'nginx', ports: [{ host: 8080, container: 70000 }] }),
  );
  const value = validateJob('createContainer', {
    image: 'nginx:alpine',
    env: ['MESSAGE=hello world'],
    command: ['sh', '-c', 'echo hello'],
    mounts: [{ source: 'mydata', target: '/data' }],
  });
  assert.deepEqual(value.env, ['MESSAGE=hello world']);
  assert.equal(value.mounts[0].readOnly, false);
});
test('engine and Kubernetes settings validated, unknown settings rejected', () => {
  assert.equal(settingsSchema.parse({}).engine, 'moby');
  assert.throws(() => settingsSchema.parse({ engine: 'external' }));
  assert.throws(() => settingsSchema.parse({ kubernetes: { port: 80 } }));
  assert.throws(() => settingsSchema.parse({ shell: 'powershell' }));
});
test('Docker multiplex logs preserve stdout, stderr and UTF-8', () => {
  const frame = (stream, text) => {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  assert.equal(
    decodeDockerStream(Buffer.concat([frame(1, '준비\n'), frame(2, 'error\n')])),
    '준비\nerror\n',
  );
  assert.equal(decodeDockerStream(Buffer.from('plain tty logs')), 'plain tty logs');
});
