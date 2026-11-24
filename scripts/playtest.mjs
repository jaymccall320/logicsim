// Interactive play test: drives the real UI with touch input in headless Chrome (iPad emulation).
// Usage: node scripts/playtest.mjs [BASE_URL] [--shots]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const base = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://127.0.0.1:8650/';
const shots = process.argv.includes('--shots');
const UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const results = []; const errors = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const dl = '/tmp/playtest-dl'; fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl, { recursive: true });

async function newPage(w, h) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined));
  await page.setUserAgent(UA);
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const bcdp = await browser.target().createCDPSession();
  await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, browserContextId: ctx.id }).catch((e) => console.log('dl setup', e.message));
  return page;
}
const L = (page, fn, ...a) => page.evaluate(fn, ...a);
const tap = async (p, x, y) => { await p.touchscreen.tap(x, y); await sleep(60); };
async function drag(p, a, b, steps = 8, hold = 0) {
  const t = await p.touchscreen.touchStart(a.x, a.y);
  if (hold) await sleep(hold);
  for (let i = 1; i <= steps; i++) { await t.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps); await sleep(8); }
  await t.end(); await sleep(60);
}
async function longPress(p, x, y) { const t = await p.touchscreen.touchStart(x, y); await sleep(650); await t.end(); await sleep(100); }
const count = (p) => L(p, () => window.logicsim.circuit.components.length);
const comps = (p) => L(p, () => window.logicsim.circuit.components.map((c) => ({ id: c.id, type: c.type, props: c.props })));
const wires = (p) => L(p, () => window.logicsim.circuit.wires.length);
const pin = (p, id, i) => L(p, (id, i) => window.logicsim.pinPos(id, i), id, i);
const pos = (p, id) => L(p, (id) => window.logicsim.compPos(id), id);
const sim = (p, id, i) => L(p, (id, i) => window.logicsim.sim.pinValue(id, i), id, i);
const shot = async (p, name) => { if (shots) await p.screenshot({ path: `/workspace/logicsim-playtest-${name}.png` }); };
async function tab(p, id) { await p.click(`.tab[data-folder="${id}"]`); await sleep(100); }
async function tiles(p) { return L(p, () => [...document.querySelectorAll('#parts .part')].map((e) => { const r = e.getBoundingClientRect(); return { label: e.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })); }
async function place(p, folder, idx, at) {
  await tab(p, folder); const t = (await tiles(p))[idx];
  const before = await count(p);
  await drag(p, t, at, 10);
  const after = await count(p);
  return { label: t.label, added: after - before, comp: (await comps(p)).at(-1) };
}
async function clearAll(p) { await L(p, () => { const c = window.logicsim.circuit; c.components = []; c.wires = []; window.logicsim.rebuild(); }); }
async function openMenuOn(p, id) {
  const c = await pos(p, id); await longPress(p, c.x, c.y);
  return L(p, () => { const m = document.getElementById('menu'); return m.hidden ? null : [...m.querySelectorAll('button')].map((b) => ({ t: b.textContent, x: b.getBoundingClientRect().x + b.getBoundingClientRect().width / 2, y: b.getBoundingClientRect().y + b.getBoundingClientRect().height / 2 })); });
}
async function menuClick(p, items, text) { const it = items?.find((b) => b.t.includes(text)); if (!it) return false; await tap(p, it.x, it.y); return true; }
const stageRect = (p) => L(p, () => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

// ============ 1. first run, fresh storage ============
let p = await newPage(1024, 1366);
await p.goto(base, { waitUntil: 'networkidle0' }); await sleep(500);
check('first run loads sample circuit', (await count(p)) === 5);
check('first-run LED is lit (AND 1,1)', (await sim(p, 'led', 0))[0] === 1);

// ============ 2. toggle inputs & read wires ============
const inB = await pos(p, 'inB'); await tap(p, inB.x, inB.y); await sleep(200);
check('tap input B toggles it', (await comps(p)).find((c) => c.id === 'inB').props.value === 0);
check('LED follows after toggle', (await sim(p, 'led', 0))[0] === 0);
const midWire = await L(p, () => { const a = window.logicsim.pinPos('nand1', 2); return { x: a.x + 45, y: a.y }; });
await tap(p, midWire.x, midWire.y);
check('tap wire shows live value popup', await L(p, () => !document.getElementById('popup').hidden && /wire/.test(document.getElementById('popup').textContent)), await L(p, () => document.getElementById('popup').textContent));
await tap(p, 400, 900);

// ============ 3. drag every tray part out ============
await clearAll(p);
const folders = ['gates', 'conn', 'in', 'out', 'custom'];
let gx = 150, gy = 200, placed = [];
for (const f of folders) {
  await tab(p, f);
  const ts = await tiles(p);
  if (f === 'custom') { check('custom folder shows empty-state message', await L(p, () => !!document.querySelector('#parts .empty'))); continue; }
  for (let i = 0; i < ts.length; i++) {
    const r = await place(p, f, i, { x: gx, y: gy });
    placed.push(r);
    check(`tray ${f}/${r.label.replace(/\n/g, ' ')} drags out one part`, r.added === 1, r.comp?.type);
    gx += 190; if (gx > 900) { gx = 150; gy += 120; }
  }
}
await shot(p, 'all-parts');
// tap-to-place (no drag)
const n0 = await count(p); await tab(p, 'gates'); const t0 = (await tiles(p))[0]; await tap(p, t0.x, t0.y);
check('tap on tray tile drops a part', (await count(p)) === n0 + 1);

// ============ 4. wiring, bus widths, mismatch ============
await clearAll(p);
const mk = async (folder, idx, at) => (await place(p, folder, idx, at)).comp.id;
let g; const a = await mk('in', 0, { x: 150, y: 300 }), b = await mk('in', 0, { x: 150, y: 420 });
g = await mk('gates', 0, { x: 450, y: 360 }); const led = await mk('out', 0, { x: 750, y: 360 });
const w1 = await wires(p);
await drag(p, await pin(p, a, 0), await pin(p, g, 0));
await drag(p, await pin(p, b, 0), await pin(p, g, 1));
await drag(p, await pin(p, g, 2), await pin(p, led, 0));
check('three wires drawn pin to pin with touch drag', (await wires(p)) === w1 + 3);
await sleep(300);
check('NAND(0,0) lights LED', (await sim(p, led, 0))[0] === 1);
for (const id of [a, b]) { const c = await pos(p, id); await tap(p, c.x, c.y); }
await sleep(300);
check('toggle both inputs -> NAND(1,1)=0', (await sim(p, led, 0))[0] === 0);
// drag from an input's body should move it, not draw a wire
const before = await pos(p, a); const wb = await wires(p);
await drag(p, before, { x: before.x, y: before.y + 60 });
const after = await pos(p, a);
check('dragging an input body moves it (no stray wire)', Math.abs(after.y - before.y - 60) < 25 && (await wires(p)) === wb, `dy=${after.y - before.y} wires ${wb}->${await wires(p)}`);
// bus mismatch
const in8 = await mk('in', 2, { x: 150, y: 700 }), led1 = await mk('out', 0, { x: 700, y: 700 });
const wm = await wires(p);
await drag(p, await pin(p, in8, 0), await pin(p, led1, 0));
check('8-bit -> 1-bit wire is rejected', (await wires(p)) === wm);
const fb = await L(p, () => ({ status: document.getElementById('status').textContent, toast: document.getElementById('toast')?.textContent ?? null, toastVisible: document.getElementById('toast') ? !document.getElementById('toast').hidden : false }));
check('mismatch gives visible feedback (toast near canvas)', fb.toastVisible && /8/.test(fb.toast ?? ''), JSON.stringify(fb));
await shot(p, 'mismatch');

// ============ 4b. 8-bit bus workflow: splitter / merger / bit switches / displays ============
await clearAll(p);
const sw8 = await mk('in', 2, { x: 200, y: 300 });                 // 8-bit switch
const spl = await mk('conn', 1, { x: 480, y: 300 });                // splitter 8 -> 4+4
const hexLo = await mk('out', 4, { x: 760, y: 220 }), hexHi = await mk('out', 4, { x: 760, y: 400 });  // hex digits
const swv = () => L(p, (id) => window.logicsim.circuit.components.find((c) => c.id === id).props.value ?? 0, sw8);
check('Connectors tray has 8->4+4 splitter', (await comps(p)).find((c) => c.id === spl)?.props.groups?.join() === '4,4');
// tap individual bit cells of the 8-bit switch (MSB on the left)
const swp = await pos(p, sw8); const cellPx = await L(p, () => 22 * window.logicsim.cam.s);
const swW = await L(p, (id) => { const c = window.logicsim.circuit.components.find((x) => x.id === id); return 196; }, sw8);
const leftEdge = swp.x - (swW / 2) * (await L(p, () => window.logicsim.cam.s));
const cellX = (bit) => leftEdge + (6 + (7 - bit) * 22 + 11) * (cellPx / 22);
await tap(p, cellX(0), swp.y - 8); await tap(p, cellX(7), swp.y - 8); await tap(p, cellX(4), swp.y - 8);
check('tapping bit cells toggles individual bits (0,4,7 -> 0x91)', (await swv()) === 0x91, `value=0x${(await swv()).toString(16)}`);
await tap(p, cellX(4), swp.y - 8);
check('tapping a set bit clears it (-> 0x81)', (await swv()) === 0x81);
await drag(p, await pin(p, sw8, 0), await pin(p, spl, 0));
await drag(p, await pin(p, spl, 1), await pin(p, hexLo, 0)); await drag(p, await pin(p, spl, 2), await pin(p, hexHi, 0));
await sleep(300);
check('8-bit -> splitter(4+4) -> 4-bit hex displays wire up without mismatch', (await wires(p)) === 3, `wires=${await wires(p)}`);
check('low nibble = 1, high nibble = 8', sim(p, hexLo, 0) && (await sim(p, hexLo, 0)).reduce((a, b, i) => a + b * 2 ** i, 0) === 1 && (await sim(p, hexHi, 0)).reduce((a, b, i) => a + b * 2 ** i, 0) === 8);
await shot(p, 'bus-workflow');
// reconfigure through long-press: 4+4 -> 8x1 should drop the two now-mismatched wires with a notice
let items = await openMenuOn(p, spl);
check('splitter menu offers width + layout presets', items?.some((b) => b.t === '4+4') && items?.some((b) => b.t === '1×8') && items?.some((b) => /Custom/.test(b.t)), items?.map((b) => b.t).join(' | '));
await menuClick(p, items, '1×8'); await sleep(200);
check('changing layout prunes wires that no longer fit and says so', (await wires(p)) === 1 && await L(p, () => !document.getElementById('toast').hidden), `wires=${await wires(p)}`);
await p.click('#undo'); await sleep(100);
check('undo restores the 4+4 layout and wires', (await wires(p)) === 3 && (await comps(p)).find((c) => c.id === spl).props.groups?.join() === '4,4');
// merger 4+4 -> 8 with swapped nibbles, shown on 8 LEDs
const mg = await mk('conn', 4, { x: 760, y: 560 }), led8 = await mk('out', 2, { x: 920, y: 560 });
await drag(p, await pin(p, spl, 2), await pin(p, mg, 0)); await drag(p, await pin(p, spl, 1), await pin(p, mg, 1)); await drag(p, await pin(p, mg, 2), await pin(p, led8, 0));
await sleep(300);
check('merger swaps nibbles: 0x81 -> 0x18', (await sim(p, led8, 0)).reduce((a, b, i) => a + b * 2 ** i, 0) === 0x18);
// constants + 7 segment
const hi = await mk('in', 4, { x: 200, y: 700 }), lo = await mk('in', 5, { x: 200, y: 780 }), seg = await mk('out', 6, { x: 600, y: 760 });
await drag(p, await pin(p, hi, 0), await pin(p, seg, 0)); await drag(p, await pin(p, lo, 0), await pin(p, seg, 3));
await sleep(300);
check('tie-high / tie-low constants drive a 7-segment pin', (await sim(p, seg, 0))[0] === 1 && (await sim(p, seg, 3))[0] === 0);
const openIn = await L(p, () => ({ n: window.logicsim.circuit.components.length }));
await shot(p, 'bus-workflow2');
// floating-input indicator exists on an unconnected gate (rings are drawn; check pixel colour near the pin)
await clearAll(p);
const ng = await mk('gates', 0, { x: 500, y: 500 });
await sleep(200);
const px = await L(p, (id) => { const q = window.logicsim.pinPos(id, 0); const c = document.getElementById('canvas'), r = c.getBoundingClientRect(), d = devicePixelRatio;
  const g = c.getContext('2d'); const x = Math.round((q.x - r.left) * d), y = Math.round((q.y - r.top) * d);
  let found = false; for (let dx = -40; dx <= 40 && !found; dx++) { const [R, G, B] = g.getImageData(x + dx, y, 1, 1).data; if (R > 200 && G > 140 && G < 200 && B < 80) found = true; } return found; }, ng);
check('unconnected gate input is flagged with an orange ring', px);
await shot(p, 'floating-input');

// ============ 5. long-press menu, rotate, delete, undo/redo ============
await clearAll(p);
g = await mk('gates', 0, { x: 450, y: 360 });
{ const a2 = await mk('in', 0, { x: 150, y: 300 }), l2 = await mk('out', 0, { x: 750, y: 360 });
  await drag(p, await pin(p, a2, 0), await pin(p, g, 0)); await drag(p, await pin(p, g, 2), await pin(p, l2, 0)); }
items = await openMenuOn(p, g);
check('long-press opens context menu', !!items, items?.map((i) => i.t).join(' | '));
await shot(p, 'menu');
const rot0 = (await L(p, (id) => window.logicsim.circuit.components.find((c) => c.id === id).rot, g));
await menuClick(p, items, 'Rotate');
check('menu Rotate turns the part', (await L(p, (id) => window.logicsim.circuit.components.find((c) => c.id === id).rot, g)) === (rot0 + 1) % 4);
const wRot = await L(p, (id) => window.logicsim.pinPos(id, 0), g);
check('rotated pin is still wire-able (pin pos is finite)', Number.isFinite(wRot.x));
items = await openMenuOn(p, g); const nBefore = await count(p), wBefore = await wires(p);
await menuClick(p, items, 'Delete');
check('menu Delete removes part and its wires', (await count(p)) === nBefore - 1 && (await wires(p)) < wBefore);
await p.click('#undo'); await sleep(100);
check('Undo restores the part', (await count(p)) === nBefore && (await wires(p)) === wBefore);
check('Redo button exists', !!(await p.$('#redo')));
if (await p.$('#redo')) { await p.click('#redo'); await sleep(100); check('Redo re-applies delete', (await count(p)) === nBefore - 1); await p.click('#undo'); }

// ============ 6. Look inside, Fit, pan, zoom ============
await clearAll(p);
const xg = await mk('gates', 5, { x: 500, y: 400 });
items = await openMenuOn(p, xg);
check('gate menu offers Look inside', !!items?.some((i) => /inside/i.test(i.t)));
await menuClick(p, items, 'inside'); await sleep(200);
check('Look inside shows read-only view bar', await L(p, () => !document.getElementById('viewbar').hidden));
const innerN = await count(p); // main circuit count unaffected
await p.click('#viewback').catch(() => {}); await sleep(100);
check('Back returns to main circuit', await L(p, () => document.getElementById('viewbar').hidden));
const cam0 = await L(p, () => ({ ...window.logicsim.cam }));
await drag(p, { x: 200, y: 900 }, { x: 350, y: 800 });
const cam1 = await L(p, () => ({ ...window.logicsim.cam }));
check('one-finger drag on empty canvas pans', Math.abs(cam1.x - cam0.x) > 10, JSON.stringify([cam0, cam1]));
// pinch
{
  const t1 = await p.touchscreen.touchStart(400, 800), t2 = await p.touchscreen.touchStart(600, 800);
  for (let i = 1; i <= 8; i++) { await t1.move(400 - i * 20, 800); await t2.move(600 + i * 20, 800); await sleep(10); }
  await t1.end(); await t2.end(); await sleep(100);
}
const cam2 = await L(p, () => ({ ...window.logicsim.cam }));
check('two-finger pinch zooms in', cam2.s > cam1.s * 1.3, `${cam1.s.toFixed(2)} -> ${cam2.s.toFixed(2)}`);
await p.click('#fit'); await sleep(100);
const cam3 = await L(p, () => ({ ...window.logicsim.cam }));
check('Fit button re-fits view', Math.abs(cam3.s - cam2.s) > 0.05 || Math.abs(cam3.x - cam2.x) > 1);

// ============ 7. autosave across reload ============
await clearAll(p);
const ia = await mk('in', 0, { x: 200, y: 400 }), ig = await mk('gates', 1, { x: 450, y: 400 }), il = await mk('out', 0, { x: 700, y: 400 });
await drag(p, await pin(p, ia, 0), await pin(p, ig, 0)); await drag(p, await pin(p, ig, 1), await pin(p, il, 0));
const c0 = await comps(p), w0 = await wires(p); await sleep(900);
await p.reload({ waitUntil: 'networkidle0' }); await sleep(600);
check('autosave: components survive reload', (await count(p)) === c0.length && (await wires(p)) === w0, `${await count(p)}/${c0.length} wires ${await wires(p)}/${w0}`);
check('autosave: reloaded circuit still simulates (NOT(0)=1)', (await sim(p, il, 0))[0] === 1);

// ============ 8. export / import ============
fs.readdirSync(dl).forEach((f) => fs.unlinkSync(`${dl}/${f}`));
await p.click('#filemenu'); await sleep(150);
const fm = await L(p, () => [...document.querySelectorAll('#menu button')].map((b) => ({ t: b.textContent, x: b.getBoundingClientRect().x + b.getBoundingClientRect().width / 2, y: b.getBoundingClientRect().y + b.getBoundingClientRect().height / 2 })));
check('File menu lists Export / Import / New', fm.length >= 3, fm.map((b) => b.t).join(' | '));
await menuClick(p, fm, 'Export');
await sleep(800);
const files = fs.readdirSync(dl);
check('export downloads a JSON file', files.length === 1, files.join(','));
let exported = null;
if (files.length) { try { exported = JSON.parse(fs.readFileSync(`${dl}/${files[0]}`, 'utf8')); } catch {} }
check('exported JSON has components and wires', exported?.components?.length === c0.length && exported?.wires?.length === w0);
await clearAll(p);
const fileInput = await p.$('#file'); await fileInput.uploadFile(`${dl}/${files[0] ?? 'none'}`); await sleep(500);
check('import restores the circuit', (await count(p)) === c0.length && (await wires(p)) === w0);
// hostile imports must not kill the app
fs.writeFileSync('/tmp/hostile.json', JSON.stringify({ version: 1, components: [{ id: 'z', type: 'FUTURE_PART', x: 10, y: 10, rot: 0, props: {} }, { id: 'n', type: 'NAND', x: 100, y: 100 }, { id: 'q', type: 'IN', x: 0, y: 0, rot: 9, props: { width: 999 } }], wires: [{ id: 'w', a: { c: 'n', p: 0 }, b: { c: 'z', p: 0 } }, { id: 'w2', a: { c: 'n', p: 77 }, b: { c: 'q', p: 0 } }] }));
const errN = errors.length;
await (await p.$('#file')).uploadFile('/tmp/hostile.json'); await sleep(600);
check('importing unknown/invalid parts does not crash the app', errors.length === errN, errors.slice(errN).join(' | ').slice(0, 200));
fs.writeFileSync('/tmp/garbage.json', '{not json');
await (await p.$('#file')).uploadFile('/tmp/garbage.json'); await sleep(300);

// ============ 8b. look inside must not corrupt the saved view; rotated bit switch; tri-state conflict ============
await clearAll(p);
const xg2 = await mk('gates', 5, { x: 500, y: 400 }); await p.click('#fit'); await sleep(100);
const camBefore = await L(p, () => ({ ...window.logicsim.cam }));
items = await openMenuOn(p, xg2); await menuClick(p, items, 'inside'); await sleep(900);   // autosave timer fires while inside
await p.click('#viewback'); await sleep(900);
await p.reload({ waitUntil: 'networkidle0' }); await sleep(500);
const camAfter = await L(p, () => ({ ...window.logicsim.cam }));
check('Look inside + back + reload keeps the main view (camera)', Math.abs(camAfter.s - camBefore.s) < 0.01 && Math.abs(camAfter.x - camBefore.x) < 1, JSON.stringify([camBefore, camAfter]));
await clearAll(p);
const rsw = await mk('in', 2, { x: 500, y: 600 });
items = await openMenuOn(p, rsw); await menuClick(p, items, 'Rotate'); await sleep(100);
const rp = await pos(p, rsw), cs = await L(p, () => window.logicsim.cam.s);
// rotated 90deg clockwise: bit 7 (left in the unrotated body) is now at the top
await tap(p, rp.x, rp.y - (196 / 2 - 6 - 11) * cs);
check('tapping a bit cell on a rotated 8-bit switch toggles the right bit (MSB)', (await L(p, (id) => window.logicsim.circuit.components.find((c) => c.id === id).props.value, rsw)) === 0x80);
await clearAll(p);
// two tri-state drivers disagreeing on a shared bus -> conflict shows on the wire
const d1 = await mk('in', 4, { x: 150, y: 300 }), d2 = await mk('in', 5, { x: 150, y: 500 });  // High / Low constants
const e1 = await mk('in', 4, { x: 150, y: 400 }), e2 = await mk('in', 4, { x: 150, y: 600 });
const t1 = await mk('conn', 6, { x: 400, y: 330 }), t2 = await mk('conn', 6, { x: 400, y: 530 }), lx = await mk('out', 0, { x: 700, y: 430 });
await drag(p, await pin(p, d1, 0), await pin(p, t1, 0)); await drag(p, await pin(p, e1, 0), await pin(p, t1, 1));
await drag(p, await pin(p, d2, 0), await pin(p, t2, 0)); await drag(p, await pin(p, e2, 0), await pin(p, t2, 1));
await drag(p, await pin(p, t1, 2), await pin(p, lx, 0)); await drag(p, await pin(p, t2, 2), await pin(p, lx, 0));
await sleep(300);
check('two enabled tri-state buffers disagreeing -> LED shows conflict (X)', (await sim(p, lx, 0))[0] === 3, JSON.stringify(await sim(p, lx, 0)));
await shot(p, 'tristate-conflict');
// empty-state hint after New
await clearAll(p); await sleep(150); await shot(p, 'empty-state');

// ============ 9. oscillator doesn't hang UI ============
await clearAll(p);
await L(p, () => { const c = window.logicsim.circuit; for (let i = 0; i < 3; i++) c.components.push({ id: 'g' + i, type: 'NAND', x: i * 120, y: 0, rot: 0, props: {} }); for (let i = 0; i < 3; i++) { const n = 'g' + ((i + 1) % 3); c.wires.push({ id: 'a' + i, a: { c: 'g' + i, p: 2 }, b: { c: n, p: 0 } }, { id: 'b' + i, a: { c: 'g' + i, p: 2 }, b: { c: n, p: 1 } }); } window.logicsim.rebuild(); });
await L(p, () => { const s = document.getElementById('speed'); s.value = '100000'; s.dispatchEvent(new Event('change')); });
const t0s = Date.now(); await p.click('#fit'); const dt = Date.now() - t0s;
check('UI responsive while a ring oscillator runs at max speed', dt < 1500, `${dt}ms`);
await p.close();

// ============ 10. layouts ============
for (const [w, h] of [[1024, 1366], [1366, 1024], [820, 1180], [1180, 820], [706, 1024]]) {
  const q = await newPage(w, h);
  await q.goto(base + '?sample', { waitUntil: 'networkidle0' }); await sleep(500);
  for (const f of ['gates', 'conn', 'in', 'out']) {
    await tab(q, f);
    const m = await L(q, () => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const parts = [...document.querySelectorAll('#parts .part')].map((e) => e.getBoundingClientRect());
      const tb = [...document.querySelectorAll('#topbar > *')].filter((e) => !e.hidden && e.offsetParent !== null).map((e) => e.getBoundingClientRect());
      return { trayBottom: r('#tray').bottom, inner: innerHeight, iw: innerWidth, topbarH: r('#topbar').height, overflowX: document.documentElement.scrollWidth > innerWidth,
        partsClipped: [...document.querySelectorAll('#parts .part')].some((e) => e.scrollWidth > e.clientWidth + 1), tiles: parts.length, minTileW: Math.min(...parts.map((x) => x.width)),
        tabsClipped: (() => { const t = document.getElementById('tabs'); return t.scrollWidth > t.clientWidth + 1; })(), tbRight: Math.max(...tb.map((x) => x.right)) };
    });
    check(`layout ${w}x${h} ${f}: tray flush bottom, no overflow`, Math.abs(m.trayBottom - m.inner) < 1 && !m.overflowX && !m.partsClipped, JSON.stringify(m));
    if (f === 'gates') check(`layout ${w}x${h}: toolbar is a single row`, m.topbarH < 64, `topbar ${m.topbarH}px`);
    if (f === 'conn' && (w === 1024 || w === 706)) await shot(q, `tray-conn-${w}x${h}`);
  }
  await shot(q, `layout-${w}x${h}`);
  await q.close();
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed; page errors: ${errors.length}`); errors.slice(0, 8).forEach((e) => console.log('  ERR', e.slice(0, 200)));
process.exit(0);
