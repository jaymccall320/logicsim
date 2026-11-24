// Builds a small 8-bit demo with the new parts (splitters/mergers, constants, hex, 7-seg) and screenshots it,
// plus the Connectors/Inputs/Outputs trays and the splitter configuration menu.
// Usage: node scripts/newparts-shot.mjs BASE_URL
import puppeteer from 'puppeteer-core';
const base = process.argv[2] ?? 'http://127.0.0.1:8650/';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await browser.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.setViewport({ width: 1024, height: 1366, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto(base + '?sample', { waitUntil: 'networkidle0' });
await page.evaluate(() => {
  const L = window.logicsim, c = L.circuit;
  const C = (id, type, x, y, props = {}, rot = 0) => ({ id, type, x, y, rot, props });
  const W = (id, a, ap, b, bp) => ({ id, a: { c: a, p: ap }, b: { c: b, p: bp } });
  c.components = [
    C('in', 'IN', 0, 0, { width: 8, value: 0x3c, label: 'DATA' }), C('sp', 'SPLIT', 200, 0, { width: 8, groups: [4, 4] }),
    C('mg', 'MERGE', 420, 0, { width: 8, groups: [4, 4] }), C('leds', 'OUT', 620, -60, { width: 8, label: 'nibbles swapped' }), C('hex', 'HEX', 640, 10, { width: 8 }),
    C('lo', 'HEX', 420, -150, { width: 4, label: 'low nibble' }), C('hi', 'HEX', 420, 150, { width: 4, label: 'high nibble' }),
    C('k', 'CONST', 0, 230, { width: 8, value: 0xa7, label: 'constant' }), C('sp2', 'SPLIT', 200, 300, { width: 8 }),
    C('hiC', 'CONST', 0, 330, { value: 1, label: 'high' }), C('loC', 'CONST', 0, 390, { value: 0, label: 'low' }),
    C('seg', 'SEG7', 640, 260, { label: 'segments' }), C('nc', 'NAND', 420, 400, {}),
  ];
  c.wires = [W('w1', 'in', 0, 'sp', 0), W('w2', 'sp', 1, 'mg', 1), W('w3', 'sp', 2, 'mg', 0), W('w4', 'mg', 2, 'leds', 0), W('w5', 'mg', 2, 'hex', 0),
    W('w6', 'sp', 1, 'lo', 0), W('w7', 'sp', 2, 'hi', 0), W('w8', 'k', 0, 'sp2', 0),
    W('s1', 'hiC', 0, 'seg', 0), W('s2', 'hiC', 0, 'seg', 1), W('s3', 'hiC', 0, 'seg', 2), W('s4', 'loC', 0, 'seg', 3), W('s5', 'hiC', 0, 'seg', 6)];
  L.rebuild(); L.fit();
});
await sleep(600);
await page.click('.tab[data-folder="conn"]');
await page.screenshot({ path: '/workspace/logicsim-playtest-bus-parts.png' });
for (const f of ['in', 'out']) { await page.click(`.tab[data-folder="${f}"]`); await sleep(100); await page.screenshot({ path: `/workspace/logicsim-playtest-tray-${f}.png`, clip: { x: 0, y: 1366 - 190, width: 1024, height: 190 } }); }
await page.click('.tab[data-folder="conn"]'); await sleep(100);
await page.screenshot({ path: '/workspace/logicsim-playtest-tray-conn.png', clip: { x: 0, y: 1366 - 190, width: 1024, height: 190 } });
// long-press the splitter -> configuration menu
const pos = await page.evaluate(() => window.logicsim.compPos('sp'));
const t = await page.touchscreen.touchStart(pos.x, pos.y); await sleep(700); await t.end(); await sleep(200);
await page.screenshot({ path: '/workspace/logicsim-playtest-splitter-menu.png' });
console.log(JSON.stringify({ menu: await page.evaluate(() => [...document.querySelectorAll('#menu button')].map((b) => b.textContent)), errors }));
await browser.close();
