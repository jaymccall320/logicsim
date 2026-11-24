// Headless smoke test + screenshot. Usage: node scripts/shot.mjs URL OUT.png
import puppeteer from 'puppeteer-core';
const [url = 'http://127.0.0.1:8650/?sample', out = '/workspace/logicsim-shot.png'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2, hasTouch: true });
await page.goto(url, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
const led = () => page.evaluate(() => window.logicsim.sim.pinValue('led', 0)[0]);
const r1 = await led();
// tap input B through the real pointer path to check interaction: B=1 -> 0, LED should turn off
const pos = await page.evaluate(() => {
  const { cam } = window.logicsim; const c = window.logicsim.circuit.components.find((x) => x.id === 'inB');
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: r.left + (c.x - 5 - cam.x) * cam.s, y: r.top + (c.y - cam.y) * cam.s };
});
await page.mouse.click(pos.x, pos.y);
await new Promise((r) => setTimeout(r, 300));
const r2 = await led();
await page.mouse.click(pos.x, pos.y);
await new Promise((r) => setTimeout(r, 300));
const r3 = await led();
// tap the wire between the NANDs to show the live-value popup
const wpos = await page.evaluate(() => {
  const { cam } = window.logicsim; const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: r.left + (230 - cam.x) * cam.s, y: r.top + (-10 - cam.y) * cam.s };
});
await page.mouse.click(wpos.x, wpos.y);
await new Promise((r) => setTimeout(r, 300));
const popup = await page.evaluate(() => { const p = document.getElementById('popup'); return p.hidden ? null : p.textContent; });
await page.screenshot({ path: out });
console.log(JSON.stringify({ ledInitial: r1, afterTapB: r2, afterTapBAgain: r3, popup, errors }));
await browser.close();
