import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = 'http://127.0.0.1:49170';
const { token } = await fetch(base + '/api/session').then((r) => r.json());
const timings = [],
  checks = [];
async function api(route, body, method = body ? 'POST' : 'GET') {
  const start = performance.now();
  const r = await fetch(base + '/api' + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Naru-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  timings.push({ route, ms: Math.round(performance.now() - start), status: r.status });
  if (!r.ok) throw new Error(JSON.stringify(result));
  return result;
}
async function job(type, payload = {}) {
  console.log('START', type);
  const j = await api('/jobs', { type, payload });
  for (let i = 0; i < 1200; i++) {
    const state = await api('/jobs/' + j.id);
    if (state.job.state === 'failed') throw new Error(state.log);
    if (state.job.state === 'succeeded') {
      console.log('PASS', type);
      checks.push(type);
      return state;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Job timeout: ' + type);
}
const fixture = 'naru-verification';
let container,
  volume = false,
  network = false;
try {
  const s = await api('/status');
  assert.equal(s.installed, true);
  if (!s.ready) await job('startRuntime');
  const current = await api('/containers');
  for (const r of current.filter((r) => r.Names?.includes('/' + fixture))) {
    if (r.State === 'running') await job('containerAction', { id: r.Id, action: 'stop' });
    await job('containerAction', { id: r.Id, action: 'remove' });
  }
  await job('pullImage', { image: 'nginx:alpine' });
  await job('createVolume', { name: fixture });
  volume = true;
  await job('createNetwork', { name: fixture });
  network = true;
  await job('createContainer', {
    image: 'nginx:alpine',
    name: fixture,
    ports: [{ host: 49281, container: 80 }],
    env: ['NARU_CHECK=verified'],
    mounts: [{ source: fixture, target: '/data' }],
  });
  // Bypass the short list cache by waiting once after mutation.
  await new Promise((r) => setTimeout(r, 3500));
  container = (await api('/containers')).find((r) => r.Names?.includes('/' + fixture));
  assert.equal(container.State, 'running');
  checks.push('container running');
  const inspect = await api(`/containers/${container.Id}/inspect`);
  assert.ok(inspect.Config.Env.includes('NARU_CHECK=verified'));
  checks.push('inspect and environment');
  const exec = await api(`/containers/${container.Id}/exec`, {
    args: ['sh', '-c', 'echo naru-stdout; echo naru-stderr >&2; echo persistent > /data/probe'],
  });
  assert.match(exec.text, /naru-stdout/);
  checks.push('exec and volume write');
  const response = await fetch('http://127.0.0.1:49281');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Welcome to nginx/);
  checks.push('Windows localhost published port');
  const logs = await api(`/containers/${container.Id}/logs`);
  assert.match(logs.text, /GET \/ HTTP/);
  checks.push('real container logs');
  assert.equal((await api(`/volumes/${fixture}/inspect`)).Name, fixture);
  checks.push('volume inspect');
  const net = (await api('/networks')).find((n) => n.Name === fixture);
  assert.equal((await api(`/networks/${net.Id}/inspect`)).Name, fixture);
  checks.push('network inspect');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByText(fixture, { exact: true }).first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: 'evidence/containers-desktop.png', fullPage: true });
    await page.getByRole('textbox', { name: '목록 검색' }).fill('does-not-exist');
    await page.getByText('검색 결과가 없습니다.').waitFor();
    await page.getByRole('textbox', { name: '목록 검색' }).fill(fixture);
    await page.getByText(fixture, { exact: true }).first().waitFor();
    checks.push('client search and empty state');
    await page.getByRole('button', { name: '컨테이너 실행', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    checks.push('modal keyboard dismiss');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'evidence/containers-mobile.png', fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.getByRole('button', { name: '메뉴 열기' }).click();
    await page.getByRole('link', { name: '설정', exact: true }).click();
    await page.getByRole('heading', { name: '내 환경에 맞게' }).waitFor();
    checks.push('mobile navigation and no document overflow');
    assert.deepEqual(errors, []);
    checks.push('browser no uncaught errors');
  } finally {
    await browser.close();
  }
  await job('containerAction', { id: container.Id, action: 'restart' });
  await new Promise((r) => setTimeout(r, 1000));
  const persisted = await api(`/containers/${container.Id}/exec`, { args: ['cat', '/data/probe'] });
  assert.match(persisted.text, /persistent/);
  checks.push('volume survives restart');
  await job('installCLI');
  checks.push('independent Windows CLI provisioned');
  console.log('ALL PASS');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      await job('containerAction', { id: container.Id, action: 'stop' });
      await job('containerAction', { id: container.Id, action: 'remove' });
    } catch (e) {
      console.error('cleanup:', e.message);
    }
  }
  if (volume)
    try {
      await job('removeVolume', { name: fixture });
    } catch (e) {
      console.error('cleanup:', e.message);
    }
  if (network)
    try {
      await job('removeNetwork', { id: fixture });
    } catch (e) {
      console.error('cleanup:', e.message);
    }
  await fs.writeFile(
    'evidence/integration.json',
    JSON.stringify(
      { at: new Date().toISOString(), passed: process.exitCode !== 1, checks, timings },
      null,
      2,
    ),
  );
}
