// naru-promo.html을 프레임 단위로 캡처해 MP4로 인코딩한다.
// 사용법: node promo/render.mjs [출력.mp4] [--fps 30] [--stills 1,5,12]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const fps = Number(opt('--fps', 30));
const stills = opt('--stills');
const out = resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || join(here, 'out', 'naru-promo.mp4'));
mkdirSync(dirname(out), { recursive: true });

// Playwright 전용 브라우저를 따로 내려받지 않도록 설치된 Chrome을 사용한다.
const browser = await chromium.launch({ channel: 'chrome', args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'naru-promo.html')).href + '?render');
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);

if (stills) {
  for (const t of stills.split(',').map(Number)) {
    await page.evaluate((t) => window.seek(t), t);
    await page.screenshot({ path: join(dirname(out), `still-${String(t).padStart(5, '0')}.png`) });
  }
  console.log('stills saved to', dirname(out));
} else {
  const ff = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'inherit'] });
  const total = Math.round(duration * fps);
  for (let f = 0; f < total; f++) {
    await page.evaluate((t) => window.seek(t), f / fps);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % fps === 0) process.stdout.write(`\r${f}/${total}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('\nsaved', out);
}
await browser.close();
