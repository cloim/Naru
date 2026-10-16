import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { command } from '../server/runner.js';
import { DATA } from '../server/state.js';
import { ensureWindowsTool } from '../server/tools.js';
const base = 'http://127.0.0.1:49170';
const { token } = await fetch(base + '/api/session').then((r) => r.json());
const checks = [],
  timings = [];
async function api(route, body) {
  const start = performance.now();
  const r = await fetch(base + '/api' + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Naru-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  timings.push({ route, ms: Math.round(performance.now() - start) });
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
      return s;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timeout ' + type);
}
let container;
try {
  for (const old of (await api('/containers')).filter((c) => c.Names.includes('/naru-live-ui'))) {
    if (old.State === 'running') await job('containerAction', { id: old.Id, action: 'stop' });
    await job('containerAction', { id: old.Id, action: 'remove' });
  }
  await job('startKubernetes');
  const nodes = JSON.parse(
    await command(
      path.join(DATA, 'bin', 'kubectl.exe'),
      ['--kubeconfig', path.join(DATA, 'kubeconfig.yaml'), 'get', 'nodes', '-o', 'json'],
      { timeout: 15000 },
    ),
  );
  assert.ok(nodes.items.length);
  checks.push('standalone Windows kubectl API access');
  assert.ok(
    Array.isArray(
      JSON.parse(
        await command(
          path.join(DATA, 'bin', 'helm.exe'),
          ['--kubeconfig', path.join(DATA, 'kubeconfig.yaml'), 'list', '-A', '-o', 'json'],
          { timeout: 15000 },
        ),
      ),
    ),
  );
  checks.push('standalone Windows Helm API access');
  const fetchBackup = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Network disabled for cached tools test');
  };
  try {
    for (const name of ['docker', 'kubectl', 'helm', 'compose', 'buildx', 'wincred'])
      await ensureWindowsTool(name);
    checks.push('verified tools reused fully offline');
  } finally {
    globalThis.fetch = fetchBackup;
  }
  const forbidden = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Naru-Token': token,
      Origin: 'https://untrusted.example',
    },
    body: '{}',
  });
  assert.equal(forbidden.status, 403);
  checks.push('real server cross-origin rejection');
  await job('createContainer', { image: 'nginx:alpine', name: 'naru-live-ui' });
  await new Promise((r) => setTimeout(r, 3500));
  container = (await api('/containers')).find((c) => c.Names.includes('/naru-live-ui'));
  assert.ok(container);
  const output = await api(`/containers/${container.Id}/exec`, {
    args: ['sh', '-c', 'echo live-stdout; echo live-stderr >&2'],
  });
  assert.match(output.text, /live-stdout/);
  assert.match(output.stderr, /live-stderr/);
  checks.push('live exec stdout and stderr preserved');
  const stats = await api(`/containers/${container.Id}/stats`);
  assert.ok(stats.memory_stats.usage > 0);
  checks.push('live Docker stats');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/containers/' + container.Id);
    await page.getByRole('button', { name: '리소스', exact: true }).click();
    await page.getByText('CPU', { exact: true }).waitFor({ timeout: 30000 });
    await page.screenshot({ path: 'evidence/live-resource-usage-desktop.png', fullPage: true });
    checks.push('live resource usage tab');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'evidence/live-resource-usage-mobile.png', fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    checks.push('live resource usage mobile overflow check');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(base + '/kubernetes');
    await page
      .getByRole('button', { name: /로그 보기/ })
      .first()
      .click();
    await page.getByRole('dialog').waitFor();
    await page.waitForFunction(
      () => document.querySelector('[role="dialog"] pre')?.textContent.length > 0,
    );
    await page.screenshot({ path: 'evidence/live-kubernetes-logs.png', fullPage: true });
    checks.push('live Kubernetes pod logs');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    checks.push('live browser no uncaught errors');
  } finally {
    await browser.close();
  }
  for (let i = 0; i < 10; i++) await api('/containers');
  const diagnostic = await api('/diagnostics');
  console.log('server RSS MB', Math.round(diagnostic.memory.rss / 1048576));
  console.log('ALL PASS');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (container)
    try {
      await job('containerAction', { id: container.Id, action: 'stop' });
      await job('containerAction', { id: container.Id, action: 'remove' });
    } catch (e) {
      console.error(e);
    }
  await fs.writeFile(
    'evidence/tools-and-live-ui.json',
    JSON.stringify(
      { at: new Date().toISOString(), passed: process.exitCode !== 1, checks, timings },
      null,
      2,
    ),
  );
}
