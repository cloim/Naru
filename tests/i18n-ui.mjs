import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Run against a Vite preview of the production build. All engine calls are mocked.
const base = process.env.NARU_I18N_URL || 'http://127.0.0.1:49181';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let writes = 0;
const settings = {
  connection: 'rancher-desktop',
  engine: 'docker',
  pollSeconds: 60,
  proxy: { http: '', https: '', noProxy: '' },
  kubernetes: { enabled: false, version: '', port: 6443, traefik: false },
};
await page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  if (route.request().method() !== 'GET') writes++;
  const responses = {
    '/api/session': { token: 'test-token' },
    '/api/status': {
      ready: true,
      running: true,
      installed: true,
      managed: true,
      pollSeconds: 60,
      connection: 'rancher-desktop',
      kubernetes: { enabled: true },
    },
    '/api/settings': settings,
    '/api/jobs': [
      { id: 'job-1', type: 'pullImage', state: 'succeeded', createdAt: '2026-10-16T01:02:03Z' },
    ],
    '/api/containers': [
      {
        Id: 'container-1',
        Names: ['/한글-name'],
        Image: 'nginx:alpine',
        State: 'running',
        Status: 'Up 1 hour',
        Ports: [],
        Labels: {},
      },
    ],
    '/api/projects': [],
    '/api/images': [
      { Id: 'sha256:image-1', RepoTags: ['nginx:alpine'], Size: 1024000, Created: 1792112523 },
    ],
    '/api/volumes': [{ Name: 'data', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/data' }],
    '/api/networks': [{ Id: 'network-1', Name: 'bridge', Driver: 'bridge', Scope: 'local' }],
    '/api/forwards': [],
    '/api/snapshots': [],
    '/api/extensions': [],
    '/api/kubernetes/state': { running: true },
    '/api/kubernetes': { items: [] },
    '/api/diagnostics': {
      distributions: ['Naru'],
      memory: { rss: 1024000 },
      node: 'v24',
      logs: {},
    },
  };
  assert.ok(Object.hasOwn(responses, url.pathname), `Unexpected API route: ${url.pathname}`);
  await route.fulfill({ json: responses[url.pathname] });
});
async function selectLanguage(code, currentLabel) {
  await page.goto(base + '/settings?tab=screen');
  await page.getByLabel(currentLabel, { exact: true }).selectOption(code);
  await page.waitForFunction((language) => document.documentElement.lang === language, code);
}
try {
  await page.goto(base + '/settings?tab=screen');
  await page.getByLabel('Display language', { exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.getByLabel('Display language', { exact: true }).inputValue(), 'en');
  await page.getByLabel('Display language', { exact: true }).selectOption('ko');
  await page.getByRole('heading', { name: '설정', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('naru.language')), 'ko');
  await page.reload();
  await page.getByLabel('표시 언어', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('표시 언어', { exact: true }).inputValue(), 'ko');
  assert.equal(await page.locator('html').getAttribute('lang'), 'ko');

  const pages = [
    ['/', 'Containers', '컨테이너'],
    ['/images', 'Images', '이미지'],
    ['/volumes', 'Volumes', '볼륨'],
    ['/networks', 'Networks', '네트워크'],
    ['/kubernetes', 'Kubernetes', 'Kubernetes'],
    ['/ports', 'Port forwarding', '포트 전달'],
    ['/snapshots', 'Snapshots', '스냅샷'],
    ['/extensions', 'Extensions', '확장'],
    ['/diagnostics', 'Diagnostics', '진단'],
    ['/jobs', 'Job history', '작업 기록'],
  ];
  for (const code of ['ko', 'en']) {
    await selectLanguage(code, '표시 언어');
    for (const [path, en, ko] of pages) {
      await page.goto(base + path);
      await page.getByRole('heading', { name: code === 'en' ? en : ko, exact: true }).waitFor();
      await page.waitForTimeout(150);
      assert.equal(await page.locator('main').getByRole('heading', { level: 1 }).count(), 0);
      assert.ok(
        !/[가-힣]/.test(
          await page
            .locator('main')
            .innerText()
            .then((text) => text.replaceAll('한글-name', '')),
        ) || code === 'ko',
        `Untranslated UI: ${path}`,
      );
    }
  }
  await page.goto(base + '/');
  await page.getByRole('button', { name: 'Run container', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(base + '/jobs');
  await page.getByRole('button', { name: 'Filter Status', exact: true }).click();
  await page.getByRole('tab', { name: 'Condition', exact: true }).click();
  assert.ok(
    (await page.getByLabel('Filter condition', { exact: true }).innerText()).includes('Contains'),
  );
  await page.getByRole('button', { name: 'Close filter popup', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/settings?tab=screen');
  await page.getByLabel('Display language', { exact: true }).waitFor();
  await page.screenshot({ path: '.local/i18n-settings-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByLabel('Open menu', { exact: true }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(writes, 0, 'Language selection should never change server settings');
  assert.deepEqual(errors, []);
  console.log(
    'Passed: default English, settings switch, persistence, both languages across 10 routes, dialog, filter, mobile, no API writes or runtime errors.',
  );
} finally {
  await browser.close();
}
