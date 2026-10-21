import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

// Isolated UI regression: no Docker engine calls or mutations.
const server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('naru.language', 'ko'));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const network = {
    Id: 'network-fixture',
    Name: 'fixture-bridge',
    Driver: 'bridge',
    Scope: 'local',
    IPAM: { Config: [{ Subnet: '172.28.0.0/16', Gateway: '172.28.0.1' }] },
    Containers: {},
  };
  const responses = {
    '/api/session': { token: 'fixture' },
    '/api/status': {
      ready: true,
      connection: 'managed',
      engine: 'docker',
      pollSeconds: 60,
    },
    '/api/jobs': [],
    '/api/containers': [],
    '/api/networks': [network],
    '/api/networks/network-fixture/inspect': network,
    '/api/volumes': [{ Name: 'fixture-volume', Driver: 'local', Mountpoint: '/data' }],
    '/api/volumes/fixture-volume/inspect': [{ Name: 'fixture-volume', Driver: 'local' }],
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    assert.ok(Object.hasOwn(responses, path), `Unexpected API route: ${path}`);
    await route.fulfill({ json: responses[path] });
  });
  await page.goto(base + 'networks');
  await page
    .getByRole('button', { name: '네트워크 생성', exact: true })
    .waitFor({ timeout: 10000 })
    .catch((error) => {
      assert.deepEqual(errors, [], 'Browser errors during network first render');
      throw error;
    });
  const cell = page.getByRole('gridcell').filter({ hasText: /^fixture-bridge$/ });
  await cell.waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  for (const open of [
    () => cell.click(),
    () =>
      page.getByRole('button', { name: 'fixture-bridge 통신 진단 (Ping)', exact: true }).click(),
  ]) {
    await open();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('172.28.0.0/16 (GW: 172.28.0.1)', { exact: true }).waitFor();
    await dialog.getByText('이 네트워크에 연결된 컨테이너가 없습니다.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '구성 (JSON)', exact: true }).click();
    await dialog.locator('pre').filter({ hasText: 'network-fixture' }).waitFor();
    await dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
    await dialog.waitFor({ state: 'detached' });
    await cell.waitFor();
  }
  await page.goto(base + 'volumes');
  const volume = page.getByRole('gridcell').filter({ hasText: /^fixture-volume$/ });
  await volume.click();
  await page.getByRole('dialog').locator('pre').filter({ hasText: 'fixture-volume' }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).first().click();
  await volume.waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: network first render, row and diagnostic details, close/reopen, volume details, no browser errors',
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
