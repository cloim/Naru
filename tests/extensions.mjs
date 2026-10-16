import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '@playwright/test';
import { command } from '../server/runner.js';
import { DATA } from '../server/state.js';
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
let ext;
try {
  await job('installCLI');
  const docker = path.join(DATA, 'bin', 'docker.exe'),
    config = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');
  assert.match(
    await command(docker, ['--config', config, '--context', 'naru', 'compose', 'version']),
    /Compose/i,
  );
  checks.push('standalone Windows Compose discovery');
  assert.match(
    await command(docker, ['--config', config, '--context', 'naru', 'buildx', 'version']),
    /buildx/i,
  );
  checks.push('standalone Windows Buildx discovery');
  assert.match(
    await command(docker, [
      '--config',
      config,
      '--context',
      'naru',
      'version',
      '--format',
      '{{.Server.Version}}',
    ]),
    /^\d/,
  );
  checks.push('standalone Windows Docker daemon access');
  const folder = path.resolve('.local/extension-fixture');
  await fs.mkdir(path.join(folder, 'ui'), { recursive: true });
  await fs.writeFile(
    path.join(folder, 'metadata.json'),
    JSON.stringify({
      ui: { 'dashboard-tab': { title: 'Naru 호환성 검증', root: '/ui', src: 'index.html' } },
      vm: { image: '${DESKTOP_PLUGIN_IMAGE}', exposes: { socket: 'naru.sock' } },
    }),
  );
  await fs.writeFile(
    path.join(folder, 'ui', 'index.html'),
    '<!doctype html><html><head><title>Extension fixture</title></head><body><h1>Naru extension fixture</h1><output id="result">ready</output></body></html>',
  );
  await fs.writeFile(
    path.join(folder, 'backend.sh'),
    '#!/bin/sh\nIFS= read -r request\nwhile IFS= read -r line; do [ "$line" = "$(printf \'\\r\')" ] && break; done\nprintf \'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 17\\r\\nConnection: close\\r\\n\\r\\n{"verified":true}\'\n',
  );
  await fs.writeFile(
    path.join(folder, 'Dockerfile'),
    'FROM nginx:alpine\nRUN apk add --no-cache socat\nCOPY ui /ui\nCOPY metadata.json /metadata.json\nCOPY backend.sh /backend.sh\nRUN chmod 755 /backend.sh\nCMD ["socat", "UNIX-LISTEN:/run/guest-services/naru.sock,fork,mode=0666", "EXEC:/backend.sh"]\n',
  );
  await job('buildImage', { context: folder, tag: 'naru-extension-verification:local' });
  const current = (await api('/extensions')).find(
    (x) => x.image === 'naru-extension-verification:local',
  );
  if (current) await job('uninstallExtension', { id: current.id, confirmation: 'REMOVE' });
  await job('installExtension', {
    image: 'naru-extension-verification:local',
    confirmation: 'TRUST',
  });
  ext = (await api('/extensions')).find((x) => x.image === 'naru-extension-verification:local');
  assert.ok(ext);
  const session = await api(`/extensions/${ext.id}/session`, {});
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 960 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(session.url);
    await page.getByRole('heading', { name: 'Naru extension fixture' }).waitFor();
    assert.equal(await page.evaluate(() => window.ddClient.host.platform), 'win32');
    checks.push('isolated extension UI and SDK injection');
    const list = await page.evaluate(() => window.ddClient.docker.listContainers({ all: true }));
    assert.ok(Array.isArray(list));
    checks.push('extension Docker list API');
    const version = await page.evaluate(async () => {
      const r = await window.ddClient.docker.cli.exec('version', [
        '--format',
        '{{.Server.Version}}',
      ]);
      return { stdout: r.stdout, code: r.code, lines: r.lines() };
    });
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d/);
    checks.push('extension blocking CLI SDK result');
    const stream = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          let output = '';
          window.ddClient.docker.cli.exec('version', ['--format', '{{.Server.Version}}'], {
            stream: {
              onOutput: (r) => (output += r.stdout || ''),
              onClose: (code) => resolve({ code, output }),
              onError: reject,
            },
          });
        }),
    );
    assert.equal(stream.code, 0);
    assert.match(stream.output, /^\d/);
    checks.push('extension streaming CLI SDK');
    const vm = await page.evaluate(async () => {
      const r = await window.ddClient.extension.vm.cli.exec('sh', ['-c', 'echo vm-works']);
      return r.stdout;
    });
    assert.match(vm, /vm-works/);
    checks.push('extension VM CLI');
    const service = await page.evaluate(() => window.ddClient.extension.vm.service.get('/health'));
    assert.equal(service.verified, true);
    checks.push('extension Unix socket HTTP service');
    await page.goto(base + '/extensions/' + ext.id);
    const frame = page.frameLocator('iframe');
    await frame
      .getByRole('heading', { name: 'Naru extension fixture' })
      .waitFor({ timeout: 30000 });
    const child = page.frames().find((f) => f.url().includes(ext.id + '.localhost'));
    assert.equal(
      await child.evaluate(() => {
        try {
          return parent.document.location.href;
        } catch {
          return 'isolated';
        }
      }),
      'isolated',
    );
    checks.push('extension iframe cannot access parent document');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'evidence/extension-fixture.png', fullPage: true });
  } finally {
    await browser.close();
  }
  console.log('ALL PASS');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (ext)
    try {
      await job('uninstallExtension', { id: ext.id, confirmation: 'REMOVE' });
    } catch (e) {
      console.error(e);
    }
  await fs.writeFile(
    'evidence/extensions.json',
    JSON.stringify(
      { at: new Date().toISOString(), passed: process.exitCode !== 1, checks },
      null,
      2,
    ),
  );
}
