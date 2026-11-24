// Screenshots: Gates folder open with every gate wired to A/B + LEDs, and the inside of an XOR.
// Usage: node scripts/gates-shot.mjs BASE_URL [w h]
import puppeteer from 'puppeteer-core';
const base = process.argv[2] ?? 'http://127.0.0.1:8650/';
const [w, h] = [Number(process.argv[3] ?? 1024), Number(process.argv[4] ?? 1366)];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto(base + '?sample', { waitUntil: 'networkidle0' });
await page.click('.tab[data-folder="gates"]');
const res = await page.evaluate(() => {
  const L = window.logicsim, c = L.circuit;
  c.components = [
    { id: 'A', type: 'IN', x: 0, y: -60, rot: 0, props: { label: 'A', value: 1 } },
    { id: 'B', type: 'IN', x: 0, y: 60, rot: 0, props: { label: 'B', value: 0 } },
  ];
  c.wires = [];
  const gates = ['NAND', 'AND', 'OR', 'NOR', 'XOR', 'XNOR', 'NOT', 'BUF'];
  gates.forEach((g, i) => {
    const x = 260, y = -315 + i * 90;
    c.components.push({ id: 'g' + g, type: g, x, y, rot: 0, props: {} }, { id: 'l' + g, type: 'OUT', x: x + 140, y, rot: 0, props: { label: g } });
    c.wires.push({ id: 'wa' + g, a: { c: 'A', p: 0 }, b: { c: 'g' + g, p: 0 } });
    const unary = g === 'NOT' || g === 'BUF';
    if (!unary) c.wires.push({ id: 'wb' + g, a: { c: 'B', p: 0 }, b: { c: 'g' + g, p: 1 } });
    c.wires.push({ id: 'wo' + g, a: { c: 'g' + g, p: unary ? 1 : 2 }, b: { c: 'l' + g, p: 0 } });
  });
  L.rebuild(); L.fit();
  return null;
});
await new Promise((r) => setTimeout(r, 600));
const leds = await page.evaluate(() => Object.fromEntries(['NAND', 'AND', 'OR', 'NOR', 'XOR', 'XNOR', 'NOT', 'BUF'].map((g) => [g, window.logicsim.sim.pinValue('l' + g, 0)[0]])));
const tray = await page.evaluate(() => ({ tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent + (t.classList.contains('active') ? '*' : '')),
  parts: [...document.querySelectorAll('.part span')].map((s) => s.textContent), right: Math.max(...[...document.querySelectorAll('.part')].map((p) => p.getBoundingClientRect().right)), inner: innerWidth }));
await page.screenshot({ path: '/workspace/logicsim-gates.png' });
await page.evaluate(() => { const L = window.logicsim; L.openChip(L.circuit.components.find((c) => c.id === 'gXOR')); });
await new Promise((r) => setTimeout(r, 400));
const title = await page.evaluate(() => document.getElementById('viewtitle').textContent);
await page.screenshot({ path: '/workspace/logicsim-inside-xor.png' });
await page.click('#viewback');
await page.click('.tab[data-folder="custom"]');
const empty = await page.evaluate(() => document.querySelector('#parts .empty')?.textContent);
await page.screenshot({ path: '/workspace/logicsim-custom-empty.png' });
console.log(JSON.stringify({ leds, tray, title, empty, errors }));
await browser.close();
