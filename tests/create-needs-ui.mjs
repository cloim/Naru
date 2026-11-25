// The create screen asks for what an image needs before its first run (GET /api/images/needs), with
// the answers read from the real postgres and mariadb images (2026-11-25).
// Usage: npm run build && node tests/create-needs-ui.mjs  (screenshots go to evidence/)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const answers = {
  'postgres:17-alpine': {
    checked: true,
    needs: [{ name: 'POSTGRES_PASSWORD', alternatives: [['POSTGRES_HOST_AUTH_METHOD', 'trust']] }],
  },
  'mariadb:11': {
    checked: true,
    needs: [
      {
        name: 'MARIADB_ROOT_PASSWORD',
        alternatives: [
          ['MARIADB_ALLOW_EMPTY_ROOT_PASSWORD', 'yes'],
          ['MARIADB_RANDOM_ROOT_PASSWORD', 'yes'],
        ],
      },
    ],
  },
  'node:22-alpine': { checked: true, needs: [] },
};
const asked = [];

const bundle = await build({
  stdin: {
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CreateContainerModal} from './src/components/CreateContainerModal.jsx';
import {setLanguage} from './src/i18n.js';
setLanguage(new URLSearchParams(location.search).get('lang') || 'ko');
createRoot(document.getElementById('root')).render(
  <CreateContainerModal isOpen busy={false} onClose={() => {}} onSubmit={(v) => { window.submitted = v; }} />);
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
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}\nhtml,body{height:100%;margin:0}</style><main id="root"></main><script>${bundle.outputFiles[0].text}</script></html>`;
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'text/html');
    return res.end(html);
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/session') return res.end(JSON.stringify({ token: 'test-session' }));
  if (req.url === '/api/engines')
    return res.end(JSON.stringify({ selected: 'local', profiles: [] }));
  if (req.url.startsWith('/api/images/needs?')) {
    const image = new URL(req.url, 'http://x').searchParams.get('image');
    asked.push(image);
    return res.end(JSON.stringify(answers[image] || { checked: false, needs: [] }));
  }
  res.end(JSON.stringify([]));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
await fs.mkdir('evidence', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/?lang=ko`);
  const imageInput = page.getByPlaceholder('nginx:alpine', { exact: false }).first();
  await imageInput.waitFor();
  const env = page.getByPlaceholder('APP_ENV=development', { exact: false });

  // Typing waits, then asks once for the whole name.
  await imageInput.fill('postgres:17-alpine');
  const notice = page.getByRole('status');
  await notice
    .getByText('이 이미지는 POSTGRES_PASSWORD 값이 없으면 시작하자마자 멈춥니다.')
    .waitFor();
  assert.deepEqual(asked, ['postgres:17-alpine']);
  await notice.getByRole('button', { name: '임의 값 만들기' }).click();
  const value = await notice.getByLabel('POSTGRES_PASSWORD').inputValue();
  assert.match(value, /^[A-Za-z0-9]{24}$/);
  await page.screenshot({ path: 'evidence/create-needs-1280.png' });
  await env.fill('TZ=Asia/Seoul');
  await notice.getByRole('button', { name: '환경 변수에 추가' }).click();
  assert.equal(await env.inputValue(), `TZ=Asia/Seoul\nPOSTGRES_PASSWORD=${value}`);
  await notice.waitFor({ state: 'detached' });

  // MariaDB: an alternative meets the need too.
  await env.fill('');
  await imageInput.fill('mariadb:11');
  await page
    .getByText('이 이미지는 MARIADB_ROOT_PASSWORD 값이 없으면 시작하자마자 멈춥니다.')
    .waitFor();
  await page.getByRole('button', { name: '대신 MARIADB_RANDOM_ROOT_PASSWORD=yes 추가' }).click();
  assert.equal(await env.inputValue(), 'MARIADB_RANDOM_ROOT_PASSWORD=yes');
  await page.getByRole('status').waitFor({ state: 'detached' });

  // Nothing to ask: an image with no needs, or one not on the engine.
  for (const image of ['node:22-alpine', 'not-pulled:1']) {
    await imageInput.fill(image);
    await page.waitForTimeout(1200);
    assert.equal(await page.getByRole('status').count(), 0, image);
  }

  // A value typed by hand counts as well.
  await imageInput.fill('postgres:17-alpine');
  await page.getByRole('status').waitFor();
  await env.fill('POSTGRES_PASSWORD=mine');
  await page.getByRole('status').waitFor({ state: 'detached' });

  await page.setViewportSize({ width: 390, height: 844 });
  await env.fill('');
  await page.getByRole('status').waitFor();
  await page.screenshot({ path: 'evidence/create-needs-390.png' });
  const box = await page.getByRole('status').boundingBox();
  for (const button of await page.getByRole('status').getByRole('button').all()) {
    const b = await button.boundingBox();
    assert.ok(b.x + b.width <= box.x + box.width + 1, `button runs out of the notice at 390px`);
  }

  const english = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await english.goto(`${url}/?lang=en`);
  await english
    .getByPlaceholder('nginx:alpine', { exact: false })
    .first()
    .fill('postgres:17-alpine');
  await english
    .getByText('This image stops right after starting unless POSTGRES_PASSWORD is set.')
    .waitFor();
  await english
    .getByRole('button', { name: 'Add POSTGRES_HOST_AUTH_METHOD=trust instead' })
    .waitFor();

  assert.deepEqual(errors, []);
  console.log('create needs: ok');
} finally {
  await browser.close();
  server.close();
}
