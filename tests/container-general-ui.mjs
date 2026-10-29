import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const fixture = {
  Id: 'a'.repeat(64),
  Name: '/cloudflared',
  Created: '2026-10-27T08:46:00Z',
  Config: {
    Image: 'cloudflare/cloudflared:latest',
    Env: [
      'APPLICATION_DATABASE_TIMEOUT_SECONDS=30',
      'PATH=/usr/local/bin:/usr/bin',
      'TOKEN=first=second',
      `LONG=${'x'.repeat(400)}`,
    ],
    Cmd: ['tunnel', 'run'],
    Entrypoint: ['cloudflared', '--no-autoupdate'],
    Labels: { 'com.docker.compose.project': 'demo' },
  },
  State: { Running: true, Status: 'running', StartedAt: '2026-10-27T08:46:01Z' },
  HostConfig: {
    Memory: 268435456,
    NanoCpus: 1500000000,
    RestartPolicy: { Name: 'always' },
    NetworkMode: 'bridge',
  },
  NetworkSettings: {
    Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }], '9000/tcp': null },
    Networks: {
      bridge: { MacAddress: '02:42:ac:11:00:02', Gateway: '172.17.0.1', IPAddress: '172.17.0.2' },
      app: { Gateway: '172.18.0.1', IPAddress: '172.18.0.2', GlobalIPv6Address: 'fd00::2' },
    },
  },
  Mounts: [{ Source: '/original-only', Destination: '/data' }],
};
let response = fixture;
let fail = false;
let logsRequests = 0;
const bundle = await build({
  stdin: {
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter, Routes, Route} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Actions,TopBar} from './src/ui.jsx';
import ContainerDetail from './src/pages/ContainerDetail.jsx';
import {setLanguage} from './src/i18n.js';
setLanguage('ko'); window.setLanguage=setLanguage;
createRoot(document.getElementById('root')).render(
<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
<Actions.Provider value={{busy:false,job:()=>{}}}>
<TopBar.Provider value={{slot:document.getElementById('actions'),setTitle:()=>{}}}>
<MemoryRouter initialEntries={['/containers/test']}><Routes><Route path="/containers/:id" element={<ContainerDetail/>}/></Routes></MemoryRouter>
</TopBar.Provider></Actions.Provider></QueryClientProvider>);
`,
    resolveDir: process.cwd(),
    loader: 'jsx',
  },
  bundle: true,
  format: 'iife',
  write: false,
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const assets = await fs.readdir('dist/assets');
const css = (
  await Promise.all(
    assets.filter((f) => f.endsWith('.css')).map((f) => fs.readFile(`dist/assets/${f}`, 'utf8')),
  )
).join('\n');
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}\nhtml,body{height:100%;margin:0}#root{height:calc(100% - 48px)}</style><header id="actions" style="height:48px;display:flex;justify-content:flex-end;gap:8px"></header><main id="root"></main><script>${bundle.outputFiles[0].text}</script></html>`;
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'text/html');
    return res.end(html);
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/engines')
    return res.end(JSON.stringify({ selected: 'local', profiles: [] }));
  if (req.url.endsWith('/inspect')) {
    res.statusCode = fail ? 503 : 200;
    return res.end(JSON.stringify(fail ? { error: 'inspect unavailable' } : response));
  }
  if (req.url.endsWith('/logs')) {
    logsRequests++;
    return res.end(JSON.stringify({ text: 'test log' }));
  }
  res.end(JSON.stringify({ token: 'test' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('컨테이너 일반 정보').waitFor();
  assert.equal(await page.locator('button[aria-pressed]').first().textContent(), '일반');
  assert.equal(
    await page.getByRole('button', { name: '일반', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(logsRequests, 0);
  for (const text of [
    'cloudflared',
    'first=second',
    '1.5 CPU',
    '256.0 MB',
    '172.17.0.2',
    '172.18.0.2',
    'fd00::2',
    'cloudflared --no-autoupdate',
  ]) {
    await page.getByText(text, { exact: true }).waitFor();
  }
  await page.getByText('127.0.0.1:18080 → 8080/tcp', { exact: false }).waitFor();
  await page.getByText('환경 변수', { exact: true }).click();
  assert.equal(await page.getByText('first=second', { exact: true }).isVisible(), false);
  await page.getByText('환경 변수', { exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '상세 정보 다운로드 (JSON)', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'cloudflared-inspect.json');
  assert.deepEqual(JSON.parse(await fs.readFile(await download.path(), 'utf8')), fixture);
  await fs.mkdir('evidence', { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    const labelLayout = await page
      .getByText('APPLICATION_DATABASE_TIMEOUT_SECONDS', { exact: true })
      .evaluate((label) => {
        const value = label.nextElementSibling;
        const shortLabel = label.closest('dl').querySelectorAll('dt')[1];
        return {
          width: label.getBoundingClientRect().width,
          shortWidth: shortLabel.getBoundingClientRect().width,
          fits: label.scrollWidth <= label.clientWidth,
          whiteSpace: getComputedStyle(label).whiteSpace,
          overflowX: getComputedStyle(label).overflowX,
          separated:
            value.getBoundingClientRect().left >= label.getBoundingClientRect().right ||
            value.getBoundingClientRect().top >= label.getBoundingClientRect().bottom,
        };
      });
    assert.ok(labelLayout.width > 180);
    assert.equal(labelLayout.width, labelLayout.shortWidth);
    assert.equal(labelLayout.fits, true);
    assert.equal(labelLayout.whiteSpace, 'nowrap');
    assert.equal(labelLayout.overflowX, 'visible');
    assert.equal(labelLayout.separated, true);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: `evidence/container-general-${width}.png` });
  }
  await page.getByRole('button', { name: '로그', exact: true }).click();
  await page.getByLabel('컨테이너 로그').waitFor();
  assert.ok(logsRequests > 0);
  response = [fixture];
  await page.reload();
  await page.getByLabel('컨테이너 일반 정보').waitFor();
  const arrayDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '상세 정보 다운로드 (JSON)', exact: true }).click();
  assert.deepEqual(
    JSON.parse(await fs.readFile(await (await arrayDownloadPromise).path(), 'utf8')),
    [fixture],
  );
  response = { Name: '/minimal', State: { StartedAt: '0001-01-01T00:00:00Z' } };
  await page.reload();
  await page.getByText('minimal', { exact: true }).waitFor();
  assert.equal(await page.getByText('Invalid Date', { exact: true }).count(), 0);
  fail = true;
  await page.reload();
  await page.getByText('inspect unavailable', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '상세 정보 다운로드 (JSON)', exact: true }).isDisabled(),
    true,
  );
  fail = false;
  response = fixture;
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await page.getByLabel('컨테이너 일반 정보').waitFor();
  await page.evaluate(() => window.setLanguage('en'));
  await page.getByRole('button', { name: 'General', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Download full details (JSON)', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: default tab, summary values, environment separators, multiple networks, collapse, full object/array downloads, mobile overflow, logs, missing data, error/retry, translations',
  );
  const audit = process.argv[2];
  if (audit) {
    const code = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [audit, '--url', url, '--project', process.cwd(), '--channel', 'chrome', '--json'],
        { stdin: 'ignore', stdio: ['ignore', 'inherit', 'inherit'] },
      );
      child.on('exit', resolve);
    });
    assert.equal(code, 0, 'UI geometry audit');
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
