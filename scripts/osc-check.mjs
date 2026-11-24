import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage(); await p.setViewport({ width: 1180, height: 820 });
await p.goto('http://127.0.0.1:8650/?sample', { waitUntil: 'networkidle0' });
const r = await p.evaluate(async () => {
  const L = window.logicsim; const c = L.circuit;
  c.components = []; c.wires = [];
  for (let i = 0; i < 3; i++) c.components.push({ id: 'g' + i, type: 'NAND', x: i * 120, y: 0, rot: 0, props: {} });
  for (let i = 0; i < 3; i++) { const n = 'g' + ((i + 1) % 3); c.wires.push({ id: 'a' + i, a: { c: 'g' + i, p: 2 }, b: { c: n, p: 0 } }, { id: 'b' + i, a: { c: 'g' + i, p: 2 }, b: { c: n, p: 1 } }); }
  L.rebuild();
  document.getElementById('speed').value = '100000'; document.getElementById('speed').dispatchEvent(new Event('change'));
  const t0 = L.sim.time; let frames = 0; const s = performance.now();
  await new Promise((res) => { const f = () => { frames++; if (performance.now() - s < 2000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  return { ticks: L.sim.time - t0, frames, stable: L.sim.stable, menuVisible: getComputedStyle(document.getElementById('menu')).display };
});
console.log(JSON.stringify(r)); await b.close();
