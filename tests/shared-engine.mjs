import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { command, distributions } from '../server/runner.js';
import { rancherRequest } from '../server/external.js';
const base = 'http://127.0.0.1:49170';
const { token } = await fetch(base + '/api/session').then((r) => r.json());
async function api(route, body) {
  const r = await fetch(base + '/api' + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Naru-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error);
  return value;
}
async function job(type, payload = {}) {
  const j = await api('/jobs', { type, payload });
  for (let i = 0; i < 360; i++) {
    const v = await api('/jobs/' + j.id);
    if (v.job.state === 'failed') throw Error(v.log || v.job.error);
    if (v.job.state === 'succeeded') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('job timeout');
}
const checks = [],
  prefix = 'naru-shared-check-' + Date.now();
let id,
  volume = false,
  network = false;
let passed = false;
try {
  const info = await rancherRequest('/info'),
    status = await api('/status');
  assert.equal(status.health.ID, info.ID);
  assert.equal(status.connection, 'rancher-desktop');
  assert.equal(status.managed, false);
  checks.push('Naru and Rancher Desktop same daemon ID');
  await job('installCLI');
  assert.equal(await command('docker', ['context', 'show']), 'rancher-desktop');
  assert.equal(await command('docker', ['info', '--format', '{{.ID}}']), info.ID);
  checks.push('plain docker CLI shares same daemon');
  const before = await api('/containers');
  const ids = (await command('docker', ['ps', '-aq', '--no-trunc']))
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  assert.deepEqual(before.map((c) => c.Id).sort(), ids);
  checks.push('existing containers identical through API and CLI');
  const blocked = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Naru-Token': token },
    body: JSON.stringify({ type: 'stopRuntime', payload: {} }),
  });
  assert.ok(blocked.status >= 400);
  checks.push('shared runtime stop blocked before dispatch');
  const images = await api('/images');
  const image = images
    .flatMap((i) => i.RepoTags || [])
    .find((t) => /^(alpine|busybox|nginx):/.test(t));
  assert.ok(image, 'cached shell image required');
  await job('createVolume', { name: prefix });
  volume = true;
  await job('createNetwork', { name: prefix });
  network = true;
  await job('createContainer', {
    image,
    name: prefix,
    command: ['sh', '-c', 'echo NARU_SHARED_LOG; exec sleep 300'],
    mounts: [{ source: prefix, target: '/proof', readOnly: false }],
  });
  id = await command('docker', ['inspect', prefix, '--format', '{{.Id}}']);
  await command('docker', ['network', 'connect', prefix, id]);
  const result = await api('/containers/' + id + '/exec', {
    args: ['sh', '-c', 'echo NARU_SHARED_EXEC; echo preserved > /proof/data'],
  });
  assert.match(result.text, /NARU_SHARED_EXEC/);
  const logs = await api('/containers/' + id + '/logs');
  assert.match(logs.text, /NARU_SHARED_LOG/);
  await job('containerAction', { id, action: 'restart' });
  const persisted = await api('/containers/' + id + '/exec', { args: ['cat', '/proof/data'] });
  assert.equal(persisted.text, 'preserved');
  checks.push('shared container lifecycle, exec, logs, volume persistence and network');
  const terminal = await api('/containers/' + id + '/terminal', { shell: '/bin/sh' });
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(terminal.url, { origin: base });
    let output = '';
    const timer = setTimeout(() => {
      ws.terminate();
      reject(Error('terminal timeout'));
    }, 15000);
    ws.on('error', reject);
    ws.on('message', (data, binary) => {
      if (binary) {
        output += data.toString();
        if (output.includes('NARU_SHARED_TTY')) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } else {
        const m = JSON.parse(data);
        if (m.type === 'error') reject(Error(m.error));
        if (m.type === 'ready')
          ws.send(JSON.stringify({ type: 'input', data: 'echo NARU_SHARED_TTY\n' }));
      }
    });
  });
  checks.push('shared engine real PTY');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByText('Rancher Desktop | Docker', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '엔진 종료', exact: true }).count(), 0);
    await page.screenshot({ path: 'evidence/shared-engine-desktop.png', fullPage: true });
    await page.goto(base + '/kubernetes');
    await page.getByRole('heading', { name: 'Rancher Desktop에서 관리하는 기능입니다' }).waitFor();
    await page.goto(base + '/containers/' + id);
    await page.getByRole('button', { name: '터미널', exact: true }).click();
    await page.getByText('연결됨', { exact: true }).waitFor();
    await page
      .getByRole('textbox', { name: '컨테이너 터미널 입력' })
      .pressSequentially('echo SHARED_BROWSER_OK');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('.xterm-accessibility')?.textContent.includes('SHARED_BROWSER_OK'),
    );
    await page.screenshot({ path: 'evidence/shared-engine-terminal.png', fullPage: true });
    assert.deepEqual(errors, []);
    checks.push('live shared browser terminal, ownership UI and no page errors');
  } finally {
    await browser.close();
  }
  assert.equal((await distributions(true)).includes('naru'), false);
  checks.push('Naru distribution remains stopped');
  passed = true;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  try {
    if (id) {
      await job('containerAction', { id, action: 'stop' });
      await job('containerAction', { id, action: 'remove' });
    }
    if (volume) await job('removeVolume', { name: prefix });
    if (network) await job('removeNetwork', { id: prefix });
  } catch (e) {
    passed = false;
    process.exitCode = 1;
    console.error(e);
  }
  await fs.writeFile(
    'evidence/shared-engine.json',
    JSON.stringify({ passed, at: new Date().toISOString(), checks }, null, 2),
  );
  console.log(passed ? 'ALL PASS' : 'FAILED', checks);
}
