// 실행: node tests/skeleton.browser.js [서비스 URL]
// API만 가짜 응답으로 교체하며 HTML, JS, CSS는 실제 서비스 산출물을 사용한다.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const baseURL = process.argv[2] || 'http://127.0.0.1:49170';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
await mkdir('evidence', { recursive: true });

try {
  for (const motion of ['reduce', 'no-preference']) {
    const context = await browser.newContext({
      reducedMotion: motion,
      viewport: { width: 1360, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let releaseImages;
    let releaseDiagnostics;
    await page.route('**/api/**', async (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      let json;
      if (endpoint === '/api/session') json = { token: 'skeleton-test' };
      else if (endpoint === '/api/status') json = { ready: true, managed: true, pollSeconds: 60 };
      else if (endpoint === '/api/jobs') json = [];
      else if (endpoint === '/api/images') {
        await new Promise((resolve) => { releaseImages = resolve; });
        json = [];
      } else if (endpoint === '/api/diagnostics') {
        await new Promise((resolve) => { releaseDiagnostics = resolve; });
        json = { distributions: ['test'], memory: { rss: 1024 }, node: 'test', logs: {} };
      } else throw new Error(`예상하지 않은 API: ${endpoint}`);
      await route.fulfill({ json });
    });

    async function verifyMotion(kind) {
      const block = page.locator('.skeleton-smooth').first();
      await block.waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      const read = () => block.evaluate((element) => {
        const style = getComputedStyle(element, '::after');
        return {
          name: style.animationName, duration: style.animationDuration,
          transform: style.transform, opacity: style.opacity, backgroundImage: style.backgroundImage,
        };
      });
      const before = await read();
      const clip = await block.boundingBox();
      const pixelsBefore = await page.screenshot({ clip });
      await page.waitForTimeout(450);
      const after = await read();
      const pixelsAfter = await page.screenshot({ clip });
      assert.equal(before.name, motion === 'reduce' ? 'skeleton-breathe' : 'skeleton-shimmer');
      assert.equal(before.duration, '1s');
      if (motion === 'reduce') {
        assert.equal(after.transform, 'none', '모션 감소에서는 위치가 이동하지 않는다');
        assert.equal(after.backgroundImage, 'none', '모션 감소용 단색 효과가 실제로 적용된다');
        assert.notEqual(after.opacity, before.opacity, '모션 감소에서도 밝기가 변한다');
      } else assert.notEqual(after.transform, before.transform, '쉬머가 이동한다');
      assert.ok(!pixelsBefore.equals(pixelsAfter), `${kind}: 화면 픽셀이 실제로 변한다`);
      assert.equal(await page.locator('.skeleton-enter').evaluate((element) =>
        getComputedStyle(element).opacity), '1');
      console.log(`PASS ${motion} ${kind}: ${JSON.stringify(after)}, 픽셀 변화 확인`);
    }

    await page.goto(`${baseURL}/images`);
    await page.locator('.data-grid .skeleton-smooth').first().waitFor();
    await verifyMotion('이미지 목록');
    assert.equal(await page.locator('.ag-overlay-no-rows-wrapper').isVisible(), false);
    await page.screenshot({ path: `evidence/skeleton-${motion}.png` });
    releaseImages();
    await page.locator('.skeleton-smooth').first().waitFor({ state: 'detached' });
    await page.locator('.ag-overlay-no-rows-wrapper').waitFor({ state: 'visible' });

    await page.goto(`${baseURL}/diagnostics`);
    await page.locator('main section .skeleton-smooth').first().waitFor();
    await verifyMotion('진단 공용 스켈레톤');
    if (motion === 'no-preference') {
      const opacity = await page.locator('.skeleton-enter').evaluate((element) => {
        const animation = element.getAnimations()[0];
        animation.pause();
        return [80, 250, 400].map((time) => {
          animation.currentTime = time;
          return Number(getComputedStyle(element).opacity);
        });
      });
      assert.equal(opacity[0], 0);
      assert.ok(opacity[1] > 0 && opacity[1] < 1);
      assert.equal(opacity[2], 1);
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok((await page.locator('.skeleton-smooth').first().boundingBox()).width > 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    releaseDiagnostics();
    await page.locator('.skeleton-smooth').first().waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser.close();
}
