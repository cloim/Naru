import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('naru.language', 'ko'));
  await page.goto('http://127.0.0.1:49170/diagnostics');
  await page.getByRole('tablist').waitFor();
  const live = await page.evaluate(async () => {
    const { token } = await fetch('/api/session').then((r) => r.json());
    const response = await fetch('/api/diagnostics/resources', {
      headers: { 'X-Naru-Token': token },
    });
    const sample = await response.json();
    return {
      status: response.status,
      timestamp: sample.timestamp,
      serverMemory: sample.server?.memory,
      hostMemory: sample.host?.memory,
      containers: sample.containers?.length,
      containerError: sample.containerError,
    };
  });
  assert.equal(live.status, 200);
  assert.ok(live.serverMemory > 0 && live.hostMemory > 0);
  assert.equal(live.containerError, null, live.containerError);
  const timestamp = live.timestamp;
  await page.waitForFunction(
    async (previous) => {
      const { token } = await fetch('/api/session').then((r) => r.json());
      const sample = await fetch('/api/diagnostics/resources', {
        headers: { 'X-Naru-Token': token },
      }).then((r) => r.json());
      return sample.timestamp > previous;
    },
    timestamp,
    { timeout: 30000, polling: 3000 },
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('canvas[role="img"]')].filter(
        (canvas) => !canvas.getAttribute('aria-label').includes('수집 중') && canvas.width > 0,
      ).length >= 4,
    undefined,
    { timeout: 30000 },
  );
  assert.equal(await page.locator('canvas[role="img"]').count(), 6);
  const tabs = page.getByRole('tab');
  assert.deepEqual(await tabs.allTextContents(), [
    '진단 그래프',
    '엔진 로그',
    'Kubernetes 로그',
    '빌드 엔진 로그',
  ]);
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
  for (const [index, name] of [
    [1, 'engine'],
    [2, 'kubernetes'],
    [3, 'buildkit'],
  ]) {
    await tabs.nth(index).click();
    assert.equal(await tabs.nth(index).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('tabpanel').getAttribute('id'), `log-panel-${name}`);
    assert.equal(await page.locator('canvas').count(), 0);
    await page.locator('pre').waitFor();
    assert.equal(await page.locator('pre').count(), 1);
  }
  await tabs.nth(3).press('ArrowRight');
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tabpanel').count(), 1);
  assert.equal(await page.locator('canvas').count(), 6);
  assert.equal(await page.locator('pre').count(), 0);
  await fs.mkdir('.local/diagnostics', { recursive: true });
  await page.evaluate(() => (document.querySelector('main').scrollTop = 0));
  await page.screenshot({ path: '.local/diagnostics/desktop.png', animations: 'disabled' });
  // Controlled samples exercise target selection, partial collection failure, and recovery.
  let failed = false;
  await page.route('**/api/diagnostics/resources', (route) =>
    route.fulfill({
      json: {
        timestamp: Date.now(),
        server: { cpu: 2, memory: 50 * 1024 ** 2 },
        host: { cpu: 25, memory: 4 * 1024 ** 3, limit: 16 * 1024 ** 3 },
        containers: failed ? null : [{ id: 'web', name: 'web', cpu: 12.5, memory: 64 * 1024 ** 2 }],
        containerError: failed ? 'Test collection failure' : null,
      },
    }),
  );
  await page.reload();
  const select = page.locator('select');
  await select.locator('option[value="web"]').waitFor({ state: 'attached' });
  await select.selectOption('web');
  await page.waitForFunction(() =>
    document.querySelector('canvas[role="img"]').getAttribute('aria-label').includes('12.5%'),
  );
  const point = page.locator('canvas[role="img"]').first();
  await point.focus();
  await page.getByRole('tooltip').waitFor();
  assert.ok((await page.getByRole('tooltip').textContent()).includes('12.5%'));
  await point.press('ArrowLeft');
  await point.press('Escape');
  await page.getByRole('tooltip').waitFor({ state: 'hidden' });
  await point.blur();
  failed = true;
  await page.getByText('Test collection failure', { exact: true }).waitFor();
  assert.ok(await select.locator('option:checked').count());
  failed = false;
  await page.getByText('Test collection failure', { exact: true }).waitFor({ state: 'hidden' });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => (document.querySelector('main').scrollTop = 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 390) {
      await page.waitForFunction(
        () => document.querySelector('aside').getBoundingClientRect().right <= 0,
      );
      await page.screenshot({ path: '.local/diagnostics/mobile.png', animations: 'disabled' });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      liveContainers: live.containers,
      checks: [
        'live sampling',
        'automatic refresh',
        'six Chart.js canvas graphs',
        'four exclusive tabs and keyboard',
        'container selection',
        'chart tooltip',
        'collection failure and recovery',
        'desktop and mobile overflow',
        'no browser errors',
      ],
    }),
  );
} finally {
  await browser.close();
}
