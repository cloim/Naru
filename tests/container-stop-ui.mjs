// The container page explains why a container stopped right away, with the real logs and states
// reproduced on a Naru engine (2026-11-25), and asks for the fix it offers.
// Usage: npm run build && node tests/container-stop-ui.mjs  (screenshots go to evidence/)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const POSTGRES_LOG = [
  '2026-11-25T06:16:17.753700000Z Error: Database is uninitialized and superuser password is not specified.',
  '2026-11-25T06:16:17.753728154Z        You must specify POSTGRES_PASSWORD to a non-empty value for the',
  '2026-11-25T06:16:17.753729729Z        superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".',
  '2026-11-25T06:16:17.753731526Z        You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all',
  '2026-11-25T06:16:17.753732350Z        connections without a password. This is *not* recommended.',
].join('\n');
const base = {
  Id: 'b'.repeat(64),
  Name: '/pg',
  Created: '2026-11-25T06:16:16Z',
  Config: {
    Image: 'postgres:17-alpine',
    Env: ['PATH=/usr/local/bin:/usr/bin', 'PGDATA=/var/lib/postgresql/data'],
    Cmd: ['postgres'],
  },
  State: {
    Status: 'exited',
    Running: false,
    ExitCode: 1,
    StartedAt: '2026-11-25T06:16:17Z',
    FinishedAt: '2026-11-25T06:16:18Z',
  },
  HostConfig: { Memory: 0, NanoCpus: 0, RestartPolicy: { Name: 'no' }, NetworkMode: 'bridge' },
  NetworkSettings: {
    Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] },
    Networks: {},
  },
  Mounts: [],
};
const scenarios = {
  env: { inspect: base, log: POSTGRES_LOG },
  port: {
    inspect: {
      ...base,
      State: {
        ...base.State,
        Status: 'created',
        ExitCode: 128,
        Error:
          'failed to set up container networking: driver failed programming external connectivity on endpoint pg (9fe1): Bind for 0.0.0.0:5432 failed: port is already allocated',
      },
    },
    log: '',
  },
  oom: {
    inspect: {
      ...base,
      HostConfig: { ...base.HostConfig, Memory: 16 * 1048576 },
      State: { ...base.State, OOMKilled: true, ExitCode: 137 },
    },
    log: '',
  },
  running: {
    inspect: {
      ...base,
      State: { Status: 'running', Running: true, StartedAt: '2026-11-25T06:16:17Z' },
    },
    log: '',
  },
};
let current = 'env';

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
setLanguage(new URLSearchParams(location.search).get('lang') || 'ko');
window.jobs = [];
const job = async (type, payload) => { window.jobs.push({ type, payload }); return { id: 'job' }; };
createRoot(document.getElementById('root')).render(
<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
<Actions.Provider value={{busy:false,job,notify:(e)=>{window.notified=String(e)}}}>
<TopBar.Provider value={{slot:document.getElementById('actions'),setTitle:()=>{}}}>
<MemoryRouter initialEntries={['/containers/pg']}><Routes><Route path="/containers/:id" element={<ContainerDetail/>}/></Routes></MemoryRouter>
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
  if (req.url.endsWith('/inspect')) return res.end(JSON.stringify(scenarios[current].inspect));
  if (req.url.endsWith('/logs')) return res.end(JSON.stringify({ text: scenarios[current].log }));
  if (req.url === '/api/session') return res.end(JSON.stringify({ token: 'test-session' }));
  res.end(JSON.stringify([]));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
await fs.mkdir('evidence', { recursive: true });
const open = async (scenario, lang = 'ko', viewport = { width: 1440, height: 900 }) => {
  current = scenario;
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/?lang=${lang}`);
  try {
    await page
      .getByRole('tab')
      .or(page.locator('button[aria-pressed]'))
      .first()
      .waitFor({ timeout: 10000 });
  } catch (e) {
    console.error('page errors:', errors, (await page.locator('body').innerText()).slice(0, 400));
    throw e;
  }
  return page;
};
try {
  // A missing password: the log line, a field with Generate, the image's own alternative.
  let page = await open('env');
  const alert = page.getByRole('alert');
  await alert.getByText('POSTGRES_PASSWORD 환경 변수가 없어 시작하지 못했습니다').waitFor();
  await alert
    .getByText('You must specify POSTGRES_PASSWORD to a non-empty value for the')
    .waitFor();
  const save = alert.getByRole('button', { name: '저장하고 시작' });
  assert.equal(await save.isDisabled(), true);
  await alert.getByRole('button', { name: '임의 값 만들기' }).click();
  const value = await alert.getByLabel('POSTGRES_PASSWORD').inputValue();
  assert.match(value, /^[A-Za-z0-9]{24}$/);
  await page.screenshot({ path: 'evidence/container-stop-env-1440.png' });
  await save.click();
  let jobs = await page.evaluate(() => window.jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'updateContainer');
  assert.equal(jobs[0].payload.start, true);
  assert.equal(jobs[0].payload.name, 'pg');
  assert.equal(jobs[0].payload.image, 'postgres:17-alpine');
  assert.deepEqual(jobs[0].payload.env, [
    'PATH=/usr/local/bin:/usr/bin',
    'PGDATA=/var/lib/postgresql/data',
    `POSTGRES_PASSWORD=${value}`,
  ]);
  assert.deepEqual(jobs[0].payload.ports, [
    { host: 5432, container: 5432, protocol: 'tcp', hostIp: '0.0.0.0' },
  ]);
  await page.close();

  page = await open('env');
  await page.getByRole('button', { name: 'POSTGRES_HOST_AUTH_METHOD=trust로 시작' }).click();
  jobs = await page.evaluate(() => window.jobs);
  assert.ok(jobs[0].payload.env.includes('POSTGRES_HOST_AUTH_METHOD=trust'));
  await page.screenshot({ path: 'evidence/container-stop-env-390.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px at 390px`);
  await page.screenshot({ path: 'evidence/container-stop-env-390.png' });
  await page.close();

  // A port conflict opens the settings, where the port can be changed.
  page = await open('port');
  await page.getByText('포트 5432을(를) 이미 다른 곳에서 쓰고 있어 시작하지 못했습니다').waitFor();
  await page
    .getByText('Bind for 0.0.0.0:5432 failed: port is already allocated', { exact: false })
    .waitFor();
  await page.screenshot({ path: 'evidence/container-stop-port-1440.png' });
  await page.getByRole('button', { name: '포트 바꾸기' }).click();
  await page.getByText('컨테이너 설정 변경').waitFor();
  await page.close();

  page = await open('oom');
  await page.getByText('메모리가 부족해 멈췄습니다').waitFor();
  await page
    .getByText('이 컨테이너의 메모리 제한은 16.8 MB입니다', { exact: false })
    .or(page.getByText('이 컨테이너의 메모리 제한은', { exact: false }))
    .first()
    .waitFor();
  await page.getByRole('button', { name: '전체 로그 보기' }).click();
  await page.getByLabel('컨테이너 로그').waitFor();
  await page.close();

  // In English, and nothing at all for a running container.
  page = await open('env', 'en');
  await page.getByText('Could not start: POSTGRES_PASSWORD is not set').waitFor();
  await page.getByRole('button', { name: 'Save and start' }).waitFor();
  await page.close();
  page = await open('running');
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.close();

  assert.deepEqual(errors, []);
  console.log('container stop reasons: ok');
} finally {
  await browser.close();
  server.close();
}
