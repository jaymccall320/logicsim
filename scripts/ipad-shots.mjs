// Emulates iPad sizes in headless Chrome, checks layout metrics and writes screenshots.
// Usage: node scripts/ipad-shots.mjs BASE_URL
import puppeteer from 'puppeteer-core';
const base = process.argv[2] ?? 'http://127.0.0.1:8650/';
const UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const views = [
  { name: 'portrait', w: 1024, h: 1366, out: '/workspace/logicsim-ipad-portrait.png' },
  { name: 'landscape', w: 1366, h: 1024, out: '/workspace/logicsim-ipad-landscape.png' },
  { name: 'air-portrait', w: 820, h: 1180, out: '/workspace/logicsim-ipad-820.png' },
  { name: 'jason-706', w: 706, h: 1024, out: '/workspace/logicsim-ipad-706.png' },
];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const v of views) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.setUserAgent(UA);
  await page.setViewport({ width: v.w, height: v.h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(base + '?sample', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 700));
  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s).getBoundingClientRect();
    const c = document.getElementById('canvas'), L = window.logicsim;
    const parts = [...document.querySelectorAll('.part')].map((e) => e.getBoundingClientRect());
    return {
      inner: [innerWidth, innerHeight], app: q('#app').height, stage: [q('#stage').width, q('#stage').height],
      canvasCss: [q('#canvas').width, q('#canvas').height], canvasPx: [c.width, c.height], dpr: devicePixelRatio,
      trayBottom: q('#tray').bottom, trayLeft: parts[0].left, trayRight: parts[parts.length - 1].right,
      scale: L.cam.s, nandCssWidth: 80 * L.cam.s, labelsVisible: [...document.querySelectorAll('.part span')].every((s) => s.getBoundingClientRect().height > 0),
      coarse: matchMedia('(pointer: coarse)').matches,
    };
  });
  await page.screenshot({ path: v.out });
  console.log(v.name, JSON.stringify(m), errors.length ? errors : '');
  await page.close();
}
await browser.close();
