// The diagnostics screen saves the report the server made (and redacted) as a text file.
// Usage: npm run build && node tests/diagnostics-report-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const report =
  'Naru diagnostic report\n\n===== WSL =====\nWSL 버전: 3.0.5.0\n\n===== data folder =====\nC:\\Users\\[USER]\\AppData\\Local\\Naru\nready\n';
let reportRequests = 0;
const bundle = await build({
  stdin: {
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Actions,TopBar} from './src/ui.jsx';
import Diagnostics from './src/pages/Diagnostics.jsx';
import {setLanguage} from './src/i18n.js';
setLanguage(new URLSearchParams(location.search).get('lang') || 'ko');
createRoot(document.getElementById('root')).render(
<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
<Actions.Provider value={{busy:false,status:{ready:true},job:()=>{},notify:(e)=>{window.notified=String(e)}}}>
<TopBar.Provider value={{slot:document.getElementById('actions'),setTitle:()=>{}}}>
<Diagnostics/>
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
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}\nhtml,body{height:100%;margin:0}</style><header id="actions" style="height:48px;display:flex;justify-content:flex-end;gap:8px"></header><main id="root"></main><script>${bundle.outputFiles[0].text}</script></html>`;
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'text/html');
    return res.end(html);
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/session') return res.end(JSON.stringify({ token: 'test-session' }));
  if (req.url === '/api/engines')
    return res.end(JSON.stringify({ selected: 'local', profiles: [] }));
  if (req.url === '/api/diagnostics/report') {
    reportRequests++;
    return res.end(JSON.stringify({ name: 'naru-report-20261125-155000.txt', text: report }));
  }
  if (req.url === '/api/diagnostics')
    return res.end(
      JSON.stringify({
        state: { running: true },
        logs: { engine: 'engine log' },
        distributions: ['naru'],
      }),
    );
  if (req.url === '/api/diagnostics/resources')
    return res.end(
      JSON.stringify({
        timestamp: Date.now(),
        containers: [],
        server: { cpu: 1, memory: 1 },
        host: { cpu: 1, memory: 1 },
      }),
    );
  res.end(JSON.stringify([]));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/?lang=ko`);
  const button = page.getByRole('button', { name: '진단 리포트 저장' });
  await button.waitFor();
  const download = page.waitForEvent('download');
  await button.click();
  const file = await download;
  assert.equal(file.suggestedFilename(), 'naru-report-20261125-155000.txt');
  assert.equal(await fs.readFile(await file.path(), 'utf8'), report);
  assert.equal(reportRequests, 1);
  await page.getByRole('button', { name: '진단 리포트 저장' }).waitFor();

  const english = await browser.newPage();
  await english.goto(`${url}/?lang=en`);
  await english.getByRole('button', { name: 'Save diagnostic report' }).waitFor();

  assert.deepEqual(errors, []);
  console.log('diagnostics report: ok');
} finally {
  await browser.close();
  server.close();
}
