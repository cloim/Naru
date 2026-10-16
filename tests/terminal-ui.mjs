import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const checks = [],
  requests = [];
const result = await build({
  stdin: {
    contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Actions} from './src/ui.jsx';import Detail from './src/pages/ContainerDetail.jsx';
window.sockets=[];
class TestSocket {
 static OPEN=1;readyState=0;sent=[];closed=false;
 constructor(url){this.url=url;window.sockets.push(this);setTimeout(()=>{if(this.closed)return;this.readyState=1;this.onmessage?.({data:JSON.stringify({type:'ready'})});this.emit('terminal-ready\\r\\n');},30);}
 emit(text){this.onmessage?.({data:new TextEncoder().encode(text).buffer});}
 send(data){this.sent.push(JSON.parse(data));}
 close(){this.closed=true;this.readyState=3;this.onclose?.({});}
}
window.WebSocket=TestSocket;
const root=createRoot(document.getElementById('root'));const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
root.render(<QueryClientProvider client={client}><Actions.Provider value={{job:()=>{},notify:()=>{},busy:false}}><MemoryRouter initialEntries={['/containers/proof']}><Routes><Route path="/containers/:id" element={<Detail/>}/></Routes></MemoryRouter></Actions.Provider></QueryClientProvider>);
`,
    resolveDir: process.cwd(),
    loader: 'jsx',
  },
  bundle: true,
  jsx: 'automatic',
  format: 'iife',
  write: false,
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
// Tailwind 유틸리티는 빌드 때 만들어지므로 production build의 CSS를 그대로 쓴다. npm run build 후 실행한다.
const css = await Promise.all(
  (await fs.readdir('dist/assets'))
    .filter((file) => file.endsWith('.css'))
    .map((file) => fs.readFile('dist/assets/' + file, 'utf8')),
);
const html = `<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><style>${css.join('\n')}</style><div id="root"></div><script>${result.outputFiles[0].text}</script></html>`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/'))
      return route.fulfill({ contentType: 'text/html', body: html });
    let value;
    if (url.pathname === '/api/session') value = { token: 'test' };
    else if (url.pathname.endsWith('/inspect'))
      value = { Name: '/proof', State: { Running: true } };
    else if (url.pathname.endsWith('/logs')) value = { text: 'logs' };
    else if (url.pathname.endsWith('/terminal')) {
      assert.equal(route.request().method(), 'POST');
      assert.equal(route.request().headers()['x-naru-token'], 'test');
      requests.push(route.request().postDataJSON());
      value = { url: `ws://127.0.0.1/api/terminal?ticket=test-${requests.length}`, engine: 'moby' };
    } else throw new Error('Unexpected request: ' + url.pathname);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto('http://127.0.0.1:49170/terminal-ui-proof');
  await page.getByLabel('컨테이너 로그').waitFor();
  assert.equal(requests.length, 0);
  await page.getByRole('button', { name: '터미널', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '연결됨' }).waitFor();
  assert.equal(requests[0].shell, '/bin/sh');
  await page.waitForFunction(() =>
    document.querySelector('.xterm-accessibility-tree')?.textContent.includes('terminal-ready'),
  );
  await page.getByLabel('컨테이너 터미널 입력', { exact: true }).pressSequentially('echo proof');
  await page.getByLabel('컨테이너 터미널 입력', { exact: true }).press('Enter');
  await page.waitForFunction(() =>
    window.sockets[0].sent.some((message) => message.type === 'input' && message.data === '\r'),
  );
  const size = await page.evaluate(() =>
    window.sockets[0].sent.find((message) => message.type === 'resize'),
  );
  assert.ok(size.cols > 10 && size.rows > 5);
  checks.push(
    'Lazy authenticated session creation, ready/binary output, keyboard input, initial size',
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    (old) =>
      window.sockets[0].sent
        .filter((message) => message.type === 'resize')
        .some((message) => message.cols < old),
    size.cols,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'evidence/terminal-mobile.png' });
  checks.push('Mobile fit/resize and no document horizontal overflow');

  await page.getByLabel('터미널 셸').selectOption('/bin/bash');
  await page.waitForFunction(() => window.sockets.length === 2 && window.sockets[0].closed);
  await page.getByRole('status').filter({ hasText: '연결됨' }).waitFor();
  assert.equal(requests[1].shell, '/bin/bash');
  await page.evaluate(() =>
    window.sockets[1].onmessage({
      data: JSON.stringify({ type: 'error', error: 'shell unavailable' }),
    }),
  );
  await page.getByRole('status').filter({ hasText: 'shell unavailable' }).waitFor();
  await page.getByRole('button', { name: '다시 연결', exact: true }).click();
  await page.waitForFunction(() => window.sockets.length === 3 && window.sockets[1].closed);
  await page.getByRole('status').filter({ hasText: '연결됨' }).waitFor();
  await page.evaluate(() => window.sockets[2].close());
  await page.getByRole('status').filter({ hasText: '터미널 세션이 종료되었습니다.' }).waitFor();
  await page.getByRole('button', { name: '다시 연결', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '연결됨' }).waitFor();
  checks.push('Shell replacement cleanup, server error, closed state and reconnect');

  await page.getByRole('button', { name: '로그', exact: true }).click();
  await page.waitForFunction(() => window.sockets.every((socket) => socket.closed));
  assert.equal(await page.locator('.xterm').count(), 0);
  checks.push('Tab departure closes every WebSocket and disposes terminal DOM');
  console.log('ALL PASS', checks);
} catch (error) {
  console.error(error);
  if (page) console.error(await page.locator('body').innerText());
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(
    'evidence/terminal-ui.json',
    JSON.stringify({ at: new Date().toISOString(), passed: !process.exitCode, checks }, null, 2),
  );
}
