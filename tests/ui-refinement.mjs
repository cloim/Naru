import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const checks = [];
const bundled = await build({
  stdin: {
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Actions} from './src/ui.jsx';
import Containers,{isSystemContainer} from './src/pages/Containers.jsx';
import ContainerDetail,{resourceUsage} from './src/pages/ContainerDetail.jsx';
import Kubernetes,{kubernetesState} from './src/pages/Kubernetes.jsx';
window.calculations={resourceUsage,isSystemContainer,kubernetesState};
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
const root=createRoot(document.getElementById('root'));
window.mount=(route)=>{client.clear();root.render(<QueryClientProvider client={client}><Actions.Provider value={{status:{ready:true,kubernetes:{version:'test',port:6445}},busy:false,job:()=>{},form:()=>{},confirm:()=>{},notify:e=>{window.lastError=e.message},view:(title,value)=>{window.inspected=value}}}><MemoryRouter key={route} initialEntries={[route]}><Routes><Route path="/" element={<Containers/>}/><Route path="/containers/:id" element={<ContainerDetail/>}/><Route path="/kubernetes" element={<Kubernetes/>}/></Routes></MemoryRouter></Actions.Provider></QueryClientProvider>)};
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
// Tailwind 유틸리티는 빌드 때 만들어지므로 production build의 CSS를 그대로 쓴다. npm run build 후 실행한다.
const css = await Promise.all(
  (await fs.readdir('dist/assets'))
    .filter((file) => file.endsWith('.css'))
    .map((file) => fs.readFile('dist/assets/' + file, 'utf8')),
);
const html = `<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><style>${css.join('\n')}</style><div id="root"></div><script>${bundled.outputFiles[0].text}</script></html>`;
const stats = {
  cpu_stats: { cpu_usage: { total_usage: 500 }, system_cpu_usage: 2000, online_cpus: 4 },
  precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
  memory_stats: { usage: 104857600, limit: 209715200, stats: { inactive_file: 20971520 } },
  networks: { eth0: { rx_bytes: 1048576, tx_bytes: 2097152 } },
  pids_stats: { current: 3 },
};
const user = {
  Id: 'naru-user',
  Names: ['/web'],
  Image: 'nginx:alpine',
  State: 'running',
  Ports: [],
};
const pod = {
  metadata: { name: 'web-abc', namespace: 'apps', creationTimestamp: '2026-01-01T00:00:00Z' },
  spec: { containers: [{ name: 'web' }] },
  status: { phase: 'Running', containerStatuses: [{ ready: true }] },
};
let statsMode = 'docker',
  statsRequests = 0;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => console.error('BROWSER', error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/'))
      return route.fulfill({ contentType: 'text/html', body: html });
    let value;
    if (url.pathname === '/api/session') value = { token: 'test' };
    else if (url.pathname === '/api/containers')
      value = [
        user,
        {
          ...user,
          Id: 'system',
          Names: ['/k8s_POD_dns'],
          Labels: { 'io.kubernetes.pod.name': 'dns' },
        },
        { ...user, Id: 'stopped', Names: ['/worker'], State: 'exited' },
      ];
    else if (url.pathname.endsWith('/inspect')) value = { Name: '/web', State: { Running: true } };
    else if (url.pathname.endsWith('/stats')) {
      statsRequests++;
      if (statsMode === 'error')
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'stats temporarily unavailable' }),
        });
      value =
        statsMode === 'docker' ? stats : { text: 'NAME CPU % MEM USAGE\nweb 1.50% 8MiB / 2GiB' };
    } else if (url.pathname.endsWith('/exec'))
      value = { text: 'stdout proof', stderr: 'stderr proof', code: 0 };
    else if (url.pathname === '/api/kubernetes/logs') {
      assert.equal(url.searchParams.get('namespace'), 'apps');
      assert.equal(url.searchParams.get('name'), 'web-abc');
      value = { text: 'real pod log fixture' };
    } else if (url.pathname === '/api/kubernetes') value = { items: [pod] };
    else if (url.pathname.endsWith('/logs')) value = { text: 'container log fixture' };
    else throw new Error('Unexpected API ' + url.pathname);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto('http://127.0.0.1:49170/ui-refinement-proof');
  const calculated = await page.evaluate((s) => window.calculations.resourceUsage(s), stats);
  assert.equal(calculated.cpu, 160);
  assert.equal(calculated.memory, 83886080);
  assert.equal(calculated.percent, 40);
  assert.equal(calculated.received, 1048576);
  assert.equal(await page.evaluate(() => window.calculations.resourceUsage({}).cpu), null);
  assert.equal(
    await page.evaluate(
      () =>
        window.calculations.resourceUsage({
          memory_stats: { usage: 5, stats: { inactive_file: 10 } },
        }).memory,
    ),
    0,
  );
  assert.equal(
    await page.evaluate(() =>
      window.calculations.kubernetesState('deployments', {
        spec: { replicas: 3 },
        status: { readyReplicas: 1, availableReplicas: 1 },
      }),
    ),
    '1/3 준비됨 | 1 사용 가능',
  );
  assert.equal(
    await page.evaluate(() =>
      window.calculations.kubernetesState('nodes', {
        status: { conditions: [{ type: 'Ready', status: 'False' }] },
      }),
    ),
    '준비 안 됨',
  );
  checks.push(
    'Docker CPU delta, cache-excluded memory, missing metrics, Kubernetes replica and node state calculations',
  );
  await page.evaluate(() => window.mount('/'));
  await page.getByRole('gridcell').filter({ hasText: 'web' }).first().waitFor();
  assert.equal(await page.getByRole('gridcell').filter({ hasText: 'k8s_POD_dns' }).count(), 0);
  await page.getByLabel('시스템 컨테이너 표시').check();
  await page.getByRole('gridcell').filter({ hasText: 'k8s_POD_dns' }).waitFor();
  await page.getByLabel('목록 검색').fill('worker');
  await page.getByRole('button', { name: /전체\s*1/, exact: true }).waitFor();
  checks.push('System container hidden by default, show toggle, search-consistent tab counts');
  await page.evaluate(() => window.mount('/containers/naru-user'));
  await page.getByLabel('컨테이너 로그').waitFor();
  assert.equal(statsRequests, 0);
  await page.getByRole('button', { name: '리소스', exact: true }).click();
  await page.getByText('160.00%', { exact: true }).waitFor();
  await page.getByText('80.0 MB', { exact: true }).waitFor();
  await page.screenshot({ path: 'evidence/resource-usage-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'evidence/resource-usage-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  statsMode = 'error';
  // 리소스 탭은 5초마다 자동으로 갱신되므로 다음 갱신에서 오류 상태가 나타난다.
  await page.getByText('stats temporarily unavailable', { exact: true }).waitFor({ timeout: 15000 });
  statsMode = 'containerd';
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await page.getByLabel('containerd 리소스 사용량').waitFor();
  await page.getByRole('button', { name: '명령 실행', exact: true }).click();
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await page.getByLabel('명령 실행 결과').filter({ hasText: 'stderr proof' }).waitFor();
  checks.push(
    'Stats active-tab requests, Docker values, API error/retry, containerd raw stats, stdout and stderr display',
  );
  await page.evaluate(() => window.mount('/kubernetes'));
  await page.getByRole('button', { name: 'web-abc 로그 보기', exact: true }).click();
  await page.getByLabel('파드 로그').filter({ hasText: 'real pod log fixture' }).waitFor();
  await page.getByRole('button', { name: '닫기', exact: true }).last().click();
  await page.getByRole('gridcell').filter({ hasText: 'web-abc' }).click();
  await page.waitForFunction(() => window.inspected?.metadata?.namespace === 'apps');
  assert.equal(await page.evaluate(() => window.inspected.metadata.namespace), 'apps');
  checks.push('Pod logs namespace/name API connection, shared Modal, resource read-only view');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checks.push('Mobile page width fits viewport');
  console.log('ALL PASS', checks);
} catch (error) {
  console.error(error);
  console.error(await page?.locator('body').innerText());
  await page?.screenshot({ path: 'evidence/ui-refinement-failure.png' });
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(
    'evidence/ui-refinement.json',
    JSON.stringify({ at: new Date().toISOString(), passed: !process.exitCode, checks }, null, 2),
  );
}
