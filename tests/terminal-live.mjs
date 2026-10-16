import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
const base = 'http://127.0.0.1:49170';
const { token } = await fetch(base + '/api/session').then((r) => r.json());
async function api(route, body, method) {
  const r = await fetch(base + '/api' + route, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Naru-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error);
  return value;
}
async function job(type, payload) {
  const j = await api('/jobs', { type, payload });
  for (let i = 0; i < 180; i++) {
    const s = await api('/jobs/' + j.id);
    if (s.job.state === 'failed') throw Error(s.log);
    if (s.job.state === 'succeeded') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('job timeout');
}
let id;
const checks = [];
const original = await api('/settings');
const alternate = process.env.NARU_TEST_ENGINE === 'containerd';
try {
  if (alternate) {
    await job('stopRuntime', {});
    await api(
      '/settings',
      { ...original, engine: 'containerd', kubernetes: { ...original.kubernetes, enabled: false } },
      'PUT',
    );
    await job('startRuntime', {});
    await job('pullImage', { image: 'nginx:alpine' });
  }
  for (const old of (await api('/containers')).filter((c) =>
    c.Names.some((n) => n.replace(/^\//, '') === 'naru-terminal-verification'),
  )) {
    if (old.State === 'running') await job('containerAction', { id: old.Id, action: 'stop' });
    await job('containerAction', { id: old.Id, action: 'remove' });
  }
  await job('createContainer', { image: 'nginx:alpine', name: 'naru-terminal-verification' });
  await new Promise((r) => setTimeout(r, 3100));
  id = (await api('/containers')).find((c) =>
    c.Names.some((n) => n.replace(/^\//, '') === 'naru-terminal-verification'),
  ).Id;
  const session = await api('/containers/' + id + '/terminal', { shell: '/bin/sh' });
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(session.url, { origin: base });
    let output = '',
      sent = false;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(Error('terminal timeout'));
    }, 20000);
    ws.on('error', reject);
    ws.on('message', (data, binary) => {
      if (binary) {
        output += data.toString();
        if (output.includes('NARU_PTY_OK') && output.includes('51 123')) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } else {
        const m = JSON.parse(data);
        if (m.type === 'error') reject(Error(m.error));
        if (m.type === 'ready' && !sent) {
          sent = true;
          ws.send(JSON.stringify({ type: 'resize', cols: 123, rows: 51 }));
          setTimeout(
            () =>
              ws.send(
                JSON.stringify({ type: 'input', data: "printf 'NARU_PTY_OK\\n'; stty size\n" }),
              ),
            300,
          );
        }
      }
    });
  });
  checks.push('real engine PTY shell input, binary output and terminal resize');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(session.url, { origin: base });
    ws.on('open', () => {
      ws.close();
      reject(Error('reused ticket accepted'));
    });
    ws.on('error', () => resolve());
  });
  checks.push('one-use session enforcement');
  if (!alternate) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/containers/' + id);
      await page.getByRole('button', { name: '터미널', exact: true }).click();
      await page.getByText('연결됨', { exact: true }).waitFor({ timeout: 20000 });
      const input = page.getByRole('textbox', { name: '컨테이너 터미널 입력' });
      await input.pressSequentially("printf 'NARU_BROWSER_OK\\n'");
      await input.press('Enter');
      await page.waitForFunction(
        () =>
          document.querySelector('.xterm-accessibility')?.textContent.includes('NARU_BROWSER_OK'),
        null,
        { timeout: 5000 },
      );
      await page.screenshot({ path: 'evidence/terminal-live-desktop.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.locator('main h2').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
      );
      await page.waitForFunction(() => {
        const screen = document.querySelector('.xterm-screen');
        return (
          screen &&
          screen.getBoundingClientRect().width <=
            document.querySelector('[data-terminal-host]').clientWidth
        );
      });
      await page.waitForFunction(
        () => document.querySelector('#main-navigation').getBoundingClientRect().right <= 1,
      );
      await page.screenshot({ path: 'evidence/terminal-live-mobile.png', fullPage: true });
      await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('#workspace').inert &&
          document.activeElement.closest('#main-navigation'),
      );
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '설정');
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () =>
          !document.querySelector('#workspace').inert &&
          document.querySelector('#main-navigation').inert,
      );
      assert.equal(
        await page.evaluate(() => document.activeElement.getAttribute('aria-label')),
        '메뉴 열기',
      );
      checks.push('mobile drawer keyboard focus trap, Escape and hidden navigation inert');
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.deepEqual(errors, []);
      checks.push('real browser terminal input, rendered output, mobile layout and no page errors');
    } finally {
      await browser.close();
    }
  }

  const blocked = await api('/containers/' + id + '/terminal', { shell: '/bin/sh' });
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(blocked.url, { origin: 'https://untrusted.example' });
    ws.on('open', () => {
      ws.close();
      reject(Error('foreign origin accepted'));
    });
    ws.on('error', () => resolve());
  });
  checks.push('WebSocket foreign origin rejection');
  await fs.writeFile(
    'evidence/terminal-' + (alternate ? 'containerd' : 'live') + '.json',
    JSON.stringify({ passed: true, date: new Date().toISOString(), checks }, null, 2),
  );
  console.log('PASS', checks);
} finally {
  if (id) {
    await job('containerAction', { id, action: 'stop' });
    await job('containerAction', { id, action: 'remove' });
  }
  if (alternate) {
    await job('stopRuntime', {});
    await api('/settings', original, 'PUT');
    await job('startRuntime', {});
  }
}
