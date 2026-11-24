import './style.css';
import { PARTS, cellW, groupsOf, pinDir, pinWorld, rotatedSize, width } from './engine/parts';
import { Sim } from './engine/sim';
import { Circuit, Component, PinRef, Wire } from './engine/types';
import { drawComponent, drawWire, formatBits, label, routeBetween, wirePath, COL } from './render';
import { load, save } from './storage';
import { sampleCircuit } from './sample';
import { sanitize } from './engine/validate';

type Pt = { x: number; y: number };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const popup = $<HTMLDivElement>('popup'), menu = $<HTMLDivElement>('menu');
const GRID = 10;
const coarse = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const stage = $<HTMLDivElement>('stage');
let cssW = 0, cssH = 0;

// ---------------- state ----------------
let circuit: Circuit = { version: 1, components: [], wires: [] };
let comps = new Map<string, Component>();
let sim: Sim = new Sim(circuit);
const cam = { x: 0, y: 0, s: 1 }; // screen = (world - cam) * s
let selected: string | null = null;
let selectedWire: string | null = null;
let running = true;
let ticksPerSec = 600;
let tickAcc = 0;
const undoStack: string[] = [];
const redoStack: string[] = [];
let inspect: { kind: 'wire'; id: string; sx: number; sy: number } | { kind: 'pin'; ref: PinRef; sx: number; sy: number } | null = null;

const uid = () => Math.random().toString(36).slice(2, 9);
const snap = (v: number) => Math.round(v / GRID) * GRID;
const toWorld = (sx: number, sy: number): Pt => ({ x: sx / cam.s + cam.x, y: sy / cam.s + cam.y });

function rebuild() {
  comps = new Map(circuit.components.map((c) => [c.id, c]));
  circuit.wires = circuit.wires.filter((w) => comps.has(w.a.c) && comps.has(w.b.c));
  sim = new Sim(circuit, sim);
  scheduleSave();
}
function pushUndo() { undoStack.push(JSON.stringify(circuit)); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
function undo() { if (readOnly()) return; const s = undoStack.pop(); if (s) { redoStack.push(JSON.stringify(circuit)); circuit = JSON.parse(s); selected = null; rebuild(); } }
function redo() { if (readOnly()) return; const s = redoStack.pop(); if (s) { undoStack.push(JSON.stringify(circuit)); circuit = JSON.parse(s); selected = null; rebuild(); } }

// ---------------- persistence ----------------
let saveTimer = 0;
function scheduleSave() {
  if (readOnly()) return; // the 'look inside' view must never overwrite the saved camera
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save('autosave', { circuit, cam: { ...cam }, vw: cssW, vh: cssH }).catch(console.warn), 400);
}
async function init() {
  const params = new URLSearchParams(location.search);
  let saved: { circuit: Circuit; cam?: typeof cam; vw?: number; vh?: number } | undefined;
  if (!params.has('sample')) { try { saved = await load('autosave'); } catch (e) { console.warn(e); } }
  const clean = saved ? sanitize(saved.circuit) : null;
  circuit = clean ? clean.circuit : sampleCircuit();
  rebuild();
  resize();
  // Restore the saved view only when the screen is the same size (otherwise it could be off-screen); else fit.
  const c = saved?.cam;
  if (clean && c && Number.isFinite(c.s) && c.s > 0.1 && Math.abs((saved?.vw ?? 0) - cssW) < 2 && Math.abs((saved?.vh ?? 0) - cssH) < 2) Object.assign(cam, c);
  else fit();
  if (clean && (clean.droppedParts.length || clean.droppedWires)) toast(`Loaded with ${clean.droppedParts.length} unknown part(s) and ${clean.droppedWires} broken wire(s) removed.`, 'info');
  requestAnimationFrame(frame);
}
function exportFile() {
  const blob = new Blob([JSON.stringify(circuit, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `circuit-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement, f = input.files?.[0];
  if (!f) return;
  try {
    const clean = sanitize(JSON.parse(await f.text()));
    if (!clean) throw new Error('this is not a LogicSim circuit file');
    if (readOnly()) { viewStack.length = 0; updateViewUI(); }
    pushUndo(); circuit = clean.circuit; selected = null; sim = new Sim({ version: 1, components: [], wires: [] }); rebuild(); fit();
    const bad = clean.droppedParts.length + clean.droppedWires;
    toast(bad ? `Imported. Removed ${clean.droppedParts.length} unknown part(s) and ${clean.droppedWires} broken wire(s).` : `Imported ${clean.circuit.components.length} parts.`, 'info');
  } catch (err) { toast('Could not import: ' + (err as Error).message); }
  input.value = '';
});

// ---------------- geometry / hit tests ----------------
function pinsOf(c: Component) { return PARTS[c.type].pins(c.props); }
function hitPin(w: Pt, tolPx = coarse ? 22 : 14): PinRef | null {
  let best: PinRef | null = null, bd = tolPx / cam.s;
  for (const c of cur().components) pinsOf(c).forEach((p, pi) => {
    const q = pinWorld(c, p), d = Math.hypot(q.x - w.x, q.y - w.y);
    if (d < bd) { bd = d; best = { c: c.id, p: pi }; }
  });
  return best;
}
function hitComp(w: Pt): Component | null {
  const list = cur().components;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i], s = rotatedSize(c);
    if (Math.abs(w.x - c.x) <= s.w / 2 + 2 && Math.abs(w.y - c.y) <= s.h / 2 + 2) return c;
  }
  return null;
}
function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function hitWire(w: Pt, tolPx = coarse ? 16 : 10): Wire | null {
  let best: Wire | null = null, bd = tolPx / cam.s;
  for (const wire of cur().wires) {
    const pts = wirePath(sim, cur().map, wire); if (!pts) continue;
    for (let i = 1; i < pts.length; i++) { const d = segDist(w, pts[i - 1], pts[i]); if (d < bd) { bd = d; best = wire; } }
  }
  return best;
}
function pinWidth(r: PinRef) { const c = cur().map.get(r.c)!; return pinsOf(c)[r.p].width; }

// ---------------- actions ----------------
const overlaps = (x: number, y: number, w: number, h: number) =>
  circuit.components.some((o) => { const q = rotatedSize(o); return Math.abs(o.x - x) < (q.w + w) / 2 + 10 && Math.abs(o.y - y) < (q.h + h) / 2 + 10; });
function addPart(type: string, at: Pt, props?: Component['props'], avoidOverlap = false) {
  if (readOnly()) return;
  pushUndo();
  const p = { ...(type === 'IN' ? { value: 0 } : {}), ...props };
  if (p.groups) p.groups = p.groups.slice();
  const c: Component = { id: uid(), type, x: snap(at.x), y: snap(at.y), rot: 0, props: p };
  if (avoidOverlap) { // tap-to-place: walk outwards until the spot is free
    const sz = rotatedSize(c);
    search: for (let ring = 0; ring < 12; ring++) for (let k = 0; k < Math.max(1, ring * 8); k++) {
      const ang = (k / Math.max(1, ring * 8)) * Math.PI * 2, x = snap(at.x + Math.cos(ang) * ring * 60), y = snap(at.y + Math.sin(ang) * ring * 50);
      if (!overlaps(x, y, sz.w, sz.h)) { c.x = x; c.y = y; break search; }
    }
  }
  circuit.components.push(c); selected = c.id; rebuild();
}
const mismatchMsg = (a: number, b: number) => `Can't connect a ${a}-bit pin to a ${b}-bit pin. Use a splitter or merger to change the width.`;
function addWire(a: PinRef, b: PinRef) {
  if (a.c === b.c && a.p === b.p) return;
  const dup = circuit.wires.some((w) => (same(w.a, a) && same(w.b, b)) || (same(w.a, b) && same(w.b, a)));
  if (dup) return;
  if (pinWidth(a) !== pinWidth(b)) { toast(mismatchMsg(pinWidth(a), pinWidth(b))); return; }
  pushUndo(); circuit.wires.push({ id: uid(), a, b }); rebuild();
}
const same = (x: PinRef, y: PinRef) => x.c === y.c && x.p === y.p;
function toggleInput(c: Component) { // single-bit switch
  c.props.value = c.props.value ? 0 : 1;
  sim.touch(c.id); scheduleSave();
}
function toggleBit(c: Component, bit: number) {
  const v = c.props.value ?? 0;
  c.props.value = (Math.floor(v / 2 ** bit) % 2 ? v - 2 ** bit : v + 2 ** bit);
  sim.touch(c.id); scheduleSave();
}
/** Which bit of a multi-bit switch is under a world point (cells are drawn MSB first), or null. */
function bitAt(c: Component, wp: Pt): number | null {
  const s = PARTS[c.type].size(c.props), n = width(c.props);
  let dx = wp.x - c.x, dy = wp.y - c.y;
  for (let r = 0; r < (c.rot & 3); r++) [dx, dy] = [dy, -dx];
  const k = Math.floor((dx + s.w / 2 - 6) / cellW(n)), ly = dy + s.h / 2;
  return k < 0 || k >= n || ly < 4 || ly > 28 ? null : n - 1 - k;
}
function deleteComp(id: string) {
  pushUndo(); circuit.components = circuit.components.filter((c) => c.id !== id);
  if (selected === id) selected = null; rebuild();
}
function deleteWire(id: string) { pushUndo(); circuit.wires = circuit.wires.filter((w) => w.id !== id); rebuild(); }
/** Drop wires whose pin no longer exists or whose width no longer matches. Returns how many went. */
function pruneWires(): number {
  const n = circuit.wires.length;
  circuit.wires = circuit.wires.filter((wr) => {
    const ca = circuit.components.find((x) => x.id === wr.a.c), cb = circuit.components.find((x) => x.id === wr.b.c);
    const pa = ca && pinsOf(ca)[wr.a.p], pb = cb && pinsOf(cb)[wr.b.p];
    return pa && pb && pa.width === pb.width;
  });
  return n - circuit.wires.length;
}
const noteRemoved = (k: number) => { if (k) toast(`${k} wire${k === 1 ? '' : 's'} no longer matched and ${k === 1 ? 'was' : 'were'} removed.`, 'info'); };
function setWidth(c: Component, w: number) {
  const max = PARTS[c.type].maxWidth; w = Math.max(1, Math.min(max, w));
  if (w === width(c.props)) return;
  pushUndo(); c.props.width = w; if (w === 1) delete c.props.width;
  if (c.type === 'IN' || c.type === 'CONST') c.props.value = (c.props.value ?? 0) % 2 ** w;
  delete c.props.groups; // splitters/mergers go back to one wire per bit
  noteRemoved(pruneWires()); rebuild();
}
function setGroups(c: Component, groups: number[]) {
  pushUndo();
  const w = groups.reduce((a, b) => a + b, 0);
  c.props.width = w; if (groups.every((g) => g === 1)) delete c.props.groups; else c.props.groups = groups;
  noteRemoved(pruneWires()); rebuild();
}
const fmtGroups = (g: number[]) => (g.length <= 4 ? g.join('+') : g.every((x) => x === g[0]) ? `${g[0]}×${g.length}` : g.join('+'));
function groupPresets(w: number): number[][] {
  const rep = (n: number) => Array.from({ length: w / n }, () => n);
  const out: number[][] = [Array.from({ length: w }, () => 1)];
  if (w >= 4 && w % 2 === 0) out.push(rep(2));
  if (w > 4 && w % 4 === 0) out.push(rep(4));
  if (w > 8 && w % 8 === 0) out.push(rep(8));
  if (w >= 2 && w % 2 === 0 && w / 2 > 1) out.push([w / 2, w / 2]);
  const seen = new Set<string>();
  return out.filter((g) => { const k = g.join(','); if (seen.has(k) || g.length > 16) return false; seen.add(k); return true; });
}
function duplicate(c: Component) {
  pushUndo();
  const d: Component = JSON.parse(JSON.stringify(c)); d.id = uid(); d.x += 40; d.y += 40;
  circuit.components.push(d); selected = d.id; rebuild();
}
function fit() {
  const r = { width: cssW, height: cssH };
  const list = cur().components;
  if (!list.length || !r.width) { cam.s = coarse ? 1.5 : 1; cam.x = -r.width / 2 / cam.s; cam.y = -r.height / 2 / cam.s; return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of list) { const s = rotatedSize(c); x0 = Math.min(x0, c.x - s.w / 2); x1 = Math.max(x1, c.x + s.w / 2); y0 = Math.min(y0, c.y - s.h / 2 - 20); y1 = Math.max(y1, c.y + s.h / 2); }
  const pad = 60;
  // cap at 2x: on a tablet a 20-unit pin pitch becomes 40 CSS px, a comfortable finger target
  cam.s = Math.min(2, Math.max(0.2, Math.min(r.width / (x1 - x0 + pad * 2), r.height / (y1 - y0 + pad * 2))));
  cam.x = (x0 + x1) / 2 - r.width / 2 / cam.s; cam.y = (y0 + y1) / 2 - r.height / 2 / cam.s;
  scheduleSave();
}
let toastTimer = 0;
function toast(msg: string, kind: 'err' | 'info' = 'err') {
  const t = $('toast'); t.textContent = msg; t.className = kind === 'info' ? 'info' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (t.hidden = true), kind === 'info' ? 3000 : 4500);
}

// ---------------- context menu ----------------
function closeMenu() { menu.hidden = true; menu.innerHTML = ''; }
function mkBtn(text: string, fn: () => void, cls = '') {
  const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls;
  b.addEventListener('pointerup', (e) => { e.stopPropagation(); fn(); closeMenu(); });
  return b;
}
function segRow(title: string, opts: Array<{ text: string; on: boolean; fn: () => void }>) {
  const row = document.createElement('div'); row.className = 'row wrap';
  const lab = document.createElement('span'); lab.textContent = title; row.append(lab);
  for (const o of opts) row.append(mkBtn(o.text, o.fn, 'seg' + (o.on ? ' on' : '')));
  return row;
}
function openFileMenu() {
  closeMenu(); hidePopup();
  menu.append(
    mkBtn('⬇ Export circuit (JSON)', exportFile),
    mkBtn('⬆ Import circuit…', () => $('file').click()),
    mkBtn('＋ New empty circuit', () => {
      if (!confirm('Start a new empty circuit? (Undo can bring it back.)')) return;
      if (readOnly()) { viewStack.length = 0; updateViewUI(); }
      pushUndo(); circuit = { version: 1, components: [], wires: [] }; rebuild(); fit();
    }),
    mkBtn('▶ Load sample circuit', () => { pushUndo(); circuit = sampleCircuit(); rebuild(); fit(); }),
  );
  menu.hidden = false;
  const br = $('filemenu').getBoundingClientRect(), mr = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(br.right - mr.width, innerWidth - mr.width - 8)) + 'px'; menu.style.top = br.bottom + 6 + 'px';
}
function widthOptions(type: string) { return type === 'HEX' ? [4, 8, 16, 32] : type === 'SPLIT' || type === 'MERGE' ? [2, 4, 8, 16, 32] : [1, 2, 4, 8, 16, 32]; }
function openMenu(sx: number, sy: number, target: { comp?: Component; wire?: Wire }) {
  closeMenu(); hidePopup();
  const btn = mkBtn;
  if (target.comp) {
    const c = target.comp, def = PARTS[c.type], w = width(c.props);
    const h = document.createElement('div'); h.className = 'row'; h.innerHTML = `<span>${def.label}${c.props.label ? ' · ' + c.props.label : ''}</span>`; menu.append(h);
    if (def.chip) menu.append(btn('🔍 Look inside', () => openChip(c)));
    if (readOnly()) { menu.hidden = false; placeMenu(sx, sy); return; }
    menu.append(btn('⟳ Rotate', () => { pushUndo(); c.rot = (c.rot + 1) & 3; rebuild(); }));
    if (def.hasWidth) menu.append(segRow(`Width: ${w} bit${w === 1 ? '' : 's'}`, widthOptions(c.type).map((n) => ({ text: String(n), on: n === w, fn: () => setWidth(c, n) }))));
    if (c.type === 'SPLIT' || c.type === 'MERGE') {
      const cur = groupsOf(c.props);
      menu.append(segRow(c.type === 'SPLIT' ? 'Split into:' : 'Join from:', [
        ...groupPresets(w).map((g) => ({ text: fmtGroups(g), on: g.join(',') === cur.join(','), fn: () => setGroups(c, g) })),
        { text: 'Custom…', on: false, fn: () => {
          const t = prompt('Group sizes, lowest bits first, separated by commas.\nExamples: 4,4   1,7   8,8   2,2,4', cur.join(','));
          if (t === null) return;
          const g = t.split(/[,+\s]+/).filter(Boolean).map(Number);
          if (!g.length || g.some((n) => !Number.isInteger(n) || n < 1) || g.reduce((a, b) => a + b, 0) > 32) { toast('Enter whole numbers that add up to 32 or less, like 4,4.'); return; }
          setGroups(c, g);
        } },
      ]));
    }
    if (c.type === 'HEX') menu.append(btn(`Show as: ${(c.props.fmt ?? 'hex') === 'hex' ? 'Hex → switch to Decimal' : 'Decimal → switch to Hex'}`, () => { pushUndo(); c.props.fmt = (c.props.fmt ?? 'hex') === 'hex' ? 'dec' : 'hex'; rebuild(); }));
    if (['IN', 'OUT', 'CONST', 'HEX', 'SEG7'].includes(c.type)) menu.append(btn('✎ Label', () => {
      const t = prompt('Label', c.props.label ?? ''); if (t !== null) { pushUndo(); c.props.label = t || undefined; rebuild(); }
    }));
    if ((c.type === 'IN' || c.type === 'CONST') && w > 1) menu.append(btn('# Set value', () => {
      const t = prompt('Value (decimal, 0x… hex or 0b… binary)', String(c.props.value ?? 0));
      if (t !== null) { const v = Number(t.trim()); if (Number.isFinite(v) && v >= 0) { pushUndo(); c.props.value = Math.floor(v) % 2 ** w; sim.touch(c.id); rebuild(); } else toast('That is not a valid number.'); }
    }));
    if (c.type === 'CONST' && w === 1) menu.append(btn(`Set to ${c.props.value ? '0 (low)' : '1 (high)'}`, () => { pushUndo(); c.props.value = c.props.value ? 0 : 1; sim.touch(c.id); rebuild(); }));
    menu.append(btn('⧉ Duplicate', () => duplicate(c)));
    menu.append(btn('🗑 Delete', () => deleteComp(c.id), 'danger'));
  } else if (target.wire) {
    if (readOnly()) return;
    const w = target.wire;
    const h = document.createElement('div'); h.className = 'row';
    h.innerHTML = `<span>Wire · ${pinWidth(w.a)}-bit</span>`; menu.append(h);
    menu.append(btn('🗑 Delete wire', () => deleteWire(w.id), 'danger'));
  }
  menu.hidden = false; placeMenu(sx, sy);
}
function placeMenu(sx: number, sy: number) {
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(sx, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(sy, innerHeight - r.height - 8) + 'px';
}
function hidePopup() { inspect = null; popup.hidden = true; selectedWire = null; }

// ---------------- canvas pointer handling ----------------
type Mode = 'none' | 'press-comp' | 'press-empty' | 'press-wire' | 'drag' | 'pan' | 'wire' | 'pinch' | 'menu';
const ptrs = new Map<number, Pt>();
let mode: Mode = 'none';
let downS: Pt = { x: 0, y: 0 }, downW: Pt = { x: 0, y: 0 };
let target: Component | null = null, targetWire: Wire | null = null, dragOff: Pt = { x: 0, y: 0 };
let wireFrom: PinRef | null = null, wireTo: Pt | null = null, wireHover: PinRef | null = null;
let pinch: { d: number; mid: Pt; s: number; cx: number; cy: number } | null = null;
let lpTimer = 0;
const local = (e: PointerEvent | MouseEvent): Pt => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!menu.hidden) { closeMenu(); }
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, local(e));
  if (ptrs.size === 2) { startPinch(); return; }
  if (ptrs.size > 2) return;
  if (e.button === 2) return; // handled by contextmenu
  downS = local(e); downW = toWorld(downS.x, downS.y);
  const pin = hitPin(downW);
  const comp = hitComp(downW);
  // inputs: tapping the body toggles, so prefer body unless finger is clearly on the pin
  let pinWins = !!pin;
  if (pin && comp && comp.id === pin.c && comp.type === 'IN' && width(comp.props) > 1) { // bit cells beat the output pin
    const q = pinWorld(comp, pinsOf(comp)[pin.p]); pinWins = Math.hypot(q.x - downW.x, q.y - downW.y) < 14 / cam.s;
  }
  if (pin && pinWins) {
    mode = 'wire'; wireFrom = pin; wireTo = downW; wireHover = null; return;
  }
  if (comp) {
    mode = 'press-comp'; target = comp; dragOff = { x: comp.x - downW.x, y: comp.y - downW.y };
  } else {
    const w = hitWire(downW);
    if (w) { mode = 'press-wire'; targetWire = w; } else mode = 'press-empty';
  }
  clearTimeout(lpTimer);
  lpTimer = window.setTimeout(() => {
    if (mode === 'press-comp' && target) { mode = 'menu'; selected = target.id; openMenu(e.clientX + 10, e.clientY + 10, { comp: target }); }
    else if (mode === 'press-wire' && targetWire) { mode = 'menu'; openMenu(e.clientX + 10, e.clientY + 10, { wire: targetWire }); }
  }, 500);
});
canvas.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) {
    return;
  }
  ptrs.set(e.pointerId, local(e));
  if (mode === 'pinch') { updatePinch(); return; }
  const p = local(e), w = toWorld(p.x, p.y);
  const moved = Math.hypot(p.x - downS.x, p.y - downS.y) > 8;
  if (moved) clearTimeout(lpTimer);
  if (readOnly() && moved && (mode === 'press-comp' || mode === 'wire')) { mode = 'pan'; wireFrom = null; }
  if (mode === 'press-comp' && moved) { pushUndo(); mode = 'drag'; selected = target!.id; hidePopup(); }
  if ((mode === 'press-empty' || mode === 'press-wire') && moved) { mode = 'pan'; }
  if (mode === 'drag' && target) {
    target.x = snap(w.x + dragOff.x); target.y = snap(w.y + dragOff.y);
    // move to top of draw order
  } else if (mode === 'pan') {
    cam.x -= (p.x - downS.x) / cam.s; cam.y -= (p.y - downS.y) / cam.s; downS = p;
  } else if (mode === 'wire') {
    wireTo = w; const h = hitPin(w, 24); wireHover = h && !same(h, wireFrom!) ? h : null;
  }
});
function endPointer(e: PointerEvent) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  clearTimeout(lpTimer);
  if (mode === 'pinch') { if (ptrs.size === 0) { mode = 'none'; scheduleSave(); } return; }
  const p = local(e);
  const moved = Math.hypot(p.x - downS.x, p.y - downS.y) > 8;
  if (e.type === 'pointercancel') { mode = 'none'; wireFrom = null; return; }
  switch (mode) {
    case 'wire':
      if (wireHover && !readOnly()) addWire(wireFrom!, wireHover);
      else if (!moved) { // tap on a pin: input body toggle if it's an input part, else inspect pin
        const c = cur().map.get(wireFrom!.c)!;
        if (c.type === 'IN' && width(c.props) === 1 && !readOnly()) toggleInput(c);
        else { inspect = { kind: 'pin', ref: wireFrom!, sx: e.clientX, sy: e.clientY }; popup.hidden = false; }
      }
      wireFrom = null; wireTo = null; wireHover = null; break;
    case 'press-comp':
      selected = target!.id; hidePopup();
      if (target!.type === 'IN' && !readOnly()) {
        if (width(target!.props) === 1) toggleInput(target!);
        else { const bit = bitAt(target!, downW); if (bit !== null) toggleBit(target!, bit); }
      }
      break;
    case 'drag': rebuild(); break;
    case 'press-wire':
      selected = null; selectedWire = targetWire!.id;
      inspect = { kind: 'wire', id: targetWire!.id, sx: e.clientX, sy: e.clientY }; popup.hidden = false; break;
    case 'press-empty': selected = null; hidePopup(); break;
    case 'pan': scheduleSave(); break;
  }
  mode = 'none'; target = null; targetWire = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const w = toWorld(local(e).x, local(e).y);
  const c = hitComp(w); if (c) { selected = c.id; openMenu(e.clientX, e.clientY, { comp: c }); mode = 'menu'; return; }
  const wr = hitWire(w); if (wr) { openMenu(e.clientX, e.clientY, { wire: wr }); mode = 'menu'; }
});
function startPinch() {
  clearTimeout(lpTimer);
  if (mode === 'drag') rebuild();
  wireFrom = null; wireTo = null; target = null;
  mode = 'pinch';
  const [a, b] = [...ptrs.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid, s: cam.s, cx: cam.x, cy: cam.y };
}
function updatePinch() {
  if (!pinch || ptrs.size < 2) return;
  const [a, b] = [...ptrs.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const s = Math.max(0.15, Math.min(4, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
  // world point under the original midpoint stays under the current midpoint
  const wx = pinch.mid.x / pinch.s + pinch.cx, wy = pinch.mid.y / pinch.s + pinch.cy;
  cam.s = s; cam.x = wx - mid.x / s; cam.y = wy - mid.y / s;
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = local(e);
  if (e.ctrlKey || !e.shiftKey && Math.abs(e.deltaY) > 0 && e.deltaMode === 0 && !e.deltaX) {
    const w = toWorld(p.x, p.y);
    cam.s = Math.max(0.15, Math.min(4, cam.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
    cam.x = w.x - p.x / cam.s; cam.y = w.y - p.y / cam.s;
  } else { cam.x += e.deltaX / cam.s; cam.y += e.deltaY / cam.s; }
  scheduleSave();
}, { passive: false });
// Block Safari's own page gestures
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => { if (!(e.target as HTMLElement).closest('#tray')) e.preventDefault(); }, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && readOnly()) { closeChip(); return; }
  if (readOnly()) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) deleteComp(selected);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWire) { deleteWire(selectedWire); hidePopup(); }
  else if (e.key === 'r' && selected) { const c = comps.get(selected); if (c) { pushUndo(); c.rot = (c.rot + 1) & 3; rebuild(); } }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});

// ---------------- parts tray (folders) ----------------
interface TrayItem { type: string; label?: string; sub?: string; props?: Component['props']; demo?: Component['props'] }
interface Folder { id: string; name: string; items: () => TrayItem[]; empty?: string }
const split = (groups: number[], sub: string): TrayItem => { const w = groups.reduce((a, b) => a + b, 0); return { type: 'SPLIT', label: 'Splitter', sub, props: { width: w, ...(groups.every((g) => g === 1) ? {} : { groups }) }, demo: groups.every((g) => g === 1) ? { width: 4 } : { width: w, groups } }; };
const merge = (groups: number[], sub: string): TrayItem => { const w = groups.reduce((a, b) => a + b, 0); return { type: 'MERGE', label: 'Merger', sub, props: { width: w, ...(groups.every((g) => g === 1) ? {} : { groups }) }, demo: groups.every((g) => g === 1) ? { width: 4 } : { width: w, groups } }; };
const FOLDERS: Folder[] = [
  { id: 'gates', name: 'Gates', items: () => ['NAND', 'NOT', 'AND', 'OR', 'NOR', 'XOR', 'XNOR', 'BUF'].map((type) => ({ type })) },
  { id: 'conn', name: 'Connectors', items: () => [
    split([1, 1, 1, 1, 1, 1, 1, 1], '8 → 8×1'), split([4, 4], '8 → 4+4'), split([8, 8], '16 → 8+8'),
    merge([1, 1, 1, 1, 1, 1, 1, 1], '8×1 → 8'), merge([4, 4], '4+4 → 8'), merge([8, 8], '8+8 → 16'),
    { type: 'TRI', label: 'Tri-state' }] },
  { id: 'in', name: 'Inputs', items: () => [
    { type: 'IN', label: 'Switch', sub: '1-bit', props: { value: 0 } }, { type: 'IN', label: 'Switch', sub: '4-bit', props: { width: 4, value: 0 } },
    { type: 'IN', label: 'Switch', sub: '8-bit', props: { width: 8, value: 0 } }, { type: 'IN', label: 'Switch', sub: '16-bit', props: { width: 16, value: 0 } },
    { type: 'CONST', label: 'High (1)', props: { value: 1 } }, { type: 'CONST', label: 'Low (0)', props: { value: 0 } },
    { type: 'CONST', label: 'Constant', sub: '8-bit', props: { width: 8, value: 0 } }] },
  { id: 'out', name: 'Outputs', items: () => [
    { type: 'OUT', label: 'LED', sub: '1-bit' }, { type: 'OUT', label: 'LEDs', sub: '4-bit', props: { width: 4 } }, { type: 'OUT', label: 'LEDs', sub: '8-bit', props: { width: 8 } },
    { type: 'OUT', label: 'LEDs', sub: '16-bit', props: { width: 16 } }, { type: 'HEX', label: 'Hex digit', sub: '4-bit', props: { width: 4 } },
    { type: 'HEX', label: 'Hex byte', sub: '8-bit', props: { width: 8 } }, { type: 'SEG7', label: '7-segment' }] },
  { id: 'custom', name: 'Custom Chips', items: () => Object.values(PARTS).filter((d) => d.chip && !d.chip.builtin).map((d) => ({ type: d.type })),
    empty: 'No custom chips yet. Soon you will select part of a circuit and save it as a chip, and it will appear here.' },
];
const tabsEl = $('tabs'), partsEl = $('parts');
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
let folder = lsGet('logicsim.folder') ?? 'gates';
if (!FOLDERS.some((f) => f.id === folder)) folder = 'gates';
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const f of FOLDERS) {
    const b = document.createElement('button'); b.className = 'tab' + (f.id === folder ? ' active' : ''); b.textContent = f.name;
    b.dataset.folder = f.id;
    b.addEventListener('click', () => { folder = f.id; lsSet('logicsim.folder', folder); renderTabs(); renderParts(); });
    tabsEl.append(b);
  }
}
function renderParts() {
  partsEl.innerHTML = '';
  const f = FOLDERS.find((x) => x.id === folder)!, items = f.items();
  if (!items.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = f.empty ?? 'Nothing here yet.'; partsEl.append(e); return; }
  for (const it of items) partsEl.append(makeTile(it));
}
function makeTile(item: TrayItem) {
  const { type } = item, def = PARTS[type];
  const el = document.createElement('div'); el.className = 'part';
  const icon = document.createElement('canvas'); const dpr = devicePixelRatio || 1;
  icon.width = 84 * dpr; icon.height = 44 * dpr; icon.style.width = '84px'; icon.style.height = '44px';
  const ic = icon.getContext('2d')!; ic.scale(dpr, dpr);
  const demoProps = { ...(item.demo ?? item.props) };
  if (['IN', 'OUT', 'CONST'].includes(type) && (demoProps.width ?? 1) > 4) demoProps.width = 4; // icon only: keep it readable
  const demo: Component = { id: 'icon', type, x: 0, y: 0, rot: 0, props: demoProps };
  const s = def.size(demo.props), k = Math.min(76 / s.w, 40 / s.h);
  ic.translate(42, 22); ic.scale(k, k); drawComponent(ic, demo, null, false);
  const name = document.createElement('span'); name.textContent = item.label ?? def.label;
  el.append(icon, name);
  if (item.sub) { const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = item.sub; el.append(sub); }
  let ghost: HTMLElement | null = null, start: Pt | null = null;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId); start = { x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) {
      ghost = icon.cloneNode() as HTMLElement; (ghost as HTMLCanvasElement).getContext('2d')!.drawImage(icon, 0, 0);
      ghost.className = 'ghost'; ghost.style.width = 84 * cam.s + 'px'; ghost.style.height = 44 * cam.s + 'px'; document.body.append(ghost);
    }
    if (ghost) { ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px'; }
  });
  const finish = (e: PointerEvent) => {
    if (!start) return;
    const r = canvas.getBoundingClientRect();
    if (ghost) {
      ghost.remove(); ghost = null;
      if (e.type === 'pointerup' && e.clientY < r.bottom && e.clientY > r.top) addPart(type, toWorld(e.clientX - r.left, e.clientY - r.top), item.props);
    } else if (e.type === 'pointerup') addPart(type, toWorld(r.width / 2, r.height / 2), item.props, true);
    start = null;
  };
  el.addEventListener('pointerup', finish); el.addEventListener('pointercancel', finish);
  return el;
}
renderTabs(); renderParts();

// ---------------- look inside a chip (read-only, live values from the main simulation) ----------------
interface View { components: Component[]; wires: Wire[]; map: Map<string, Component>; title: string; savedCam?: typeof cam }
const viewStack: View[] = [];
function cur() { return viewStack[viewStack.length - 1] ?? { components: circuit.components, wires: circuit.wires, map: comps, title: '' }; }
const readOnly = () => viewStack.length > 0;
function openChip(c: Component) {
  const chip = PARTS[c.type].chip; if (!chip) return;
  const pre = c.id + '/', w = width(c.props);
  const components = chip.circuit.components.map((ic) => ({ ...ic, id: pre + ic.id, props: { ...ic.props, ...(PARTS[ic.type]?.hasWidth && w > 1 ? { width: w } : {}) } }));
  const wires = chip.circuit.wires.map((iw) => ({ id: pre + iw.id, a: { c: pre + iw.a.c, p: iw.a.p }, b: { c: pre + iw.b.c, p: iw.b.p } }));
  const path = [...viewStack.map((v) => v.title.split(' › ').pop()), chip.label].filter(Boolean).join(' › ');
  viewStack.push({ components, wires, map: new Map(components.map((x) => [x.id, x])), title: path, savedCam: { ...cam } });
  selected = null; hidePopup(); closeMenu(); updateViewUI(); fit();
}
function closeChip() {
  const v = viewStack.pop(); if (!v) return;
  if (v.savedCam) Object.assign(cam, v.savedCam);
  hidePopup(); updateViewUI(); scheduleSave();
}
function updateViewUI() {
  const bar = $('viewbar'), ro = readOnly();
  bar.hidden = !ro; $('tray').classList.toggle('disabled', ro);
  if (ro) {
    const v = cur(), nands = v.components.filter((x) => x.type === 'NAND').length, chips = v.components.filter((x) => PARTS[x.type]?.chip).length;
    $('viewtitle').textContent = `Inside ${v.title}: ${nands} NAND${nands === 1 ? '' : 's'}${chips ? `, ${chips} chip${chips === 1 ? '' : 's'}` : ''} (live, read-only)`;
  }
}
$('viewback').addEventListener('click', closeChip);

// ---------------- top bar ----------------
function togglePlay() { running = !running; $('play').textContent = running ? 'Pause' : 'Run'; }
$('play').addEventListener('click', togglePlay);
$('step').addEventListener('click', () => { if (running) togglePlay(); sim.tick(); });
$<HTMLSelectElement>('speed').addEventListener('change', (e) => (ticksPerSec = Number((e.target as HTMLSelectElement).value)));
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('fit').addEventListener('click', fit);
$('filemenu').addEventListener('click', openFileMenu);

// ---------------- render loop ----------------
/** Size the backing store from the stage's CSS box (never from the canvas itself, which has an intrinsic size). */
function resize() {
  const dpr = devicePixelRatio || 1;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  // keep the world point at the centre of the view fixed across rotation / resize
  if (cssW && cssH) { cam.x += (cssW - w) / 2 / cam.s; cam.y += (cssH - h) / 2 / cam.s; }
  cssW = w; cssH = h;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  draw();
}
/** App height follows the *visible* viewport (Safari toolbars, rotation, home-screen mode). */
function layoutViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty('--app-h', `${vv ? vv.height : innerHeight}px`);
}
layoutViewport();
window.visualViewport?.addEventListener('resize', layoutViewport);
window.addEventListener('resize', layoutViewport);
window.addEventListener('orientationchange', () => setTimeout(() => { layoutViewport(); resize(); }, 250));
new ResizeObserver(resize).observe(stage);
let last = performance.now(), lastStatus = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (running) {
    tickAcc += dt * ticksPerSec;
    const n = Math.min(Math.floor(tickAcc), 20000);
    tickAcc -= n; if (tickAcc > ticksPerSec) tickAcc = 0;
    if (n > 0) sim.run(n, 150_000); // bounded work per frame: oscillators can't hang the tab
    if (sim.stable) tickAcc = 0;
  }
  draw();
  if (now > lastStatus + 250) {
    lastStatus = now;
    $('status').textContent = `t=${sim.time}${sim.stable ? ' · stable' : running ? ' · running' : ' · paused'}`;
  }
  requestAnimationFrame(frame);
}
function draw() {
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#14161c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.s * dpr, 0, 0, cam.s * dpr, -cam.x * cam.s * dpr, -cam.y * cam.s * dpr);
  // grid dots
  const W = cssW / cam.s, H = cssH / cam.s;
  const step = cam.s < 0.5 ? 100 : 20;
  ctx.fillStyle = '#2a2e3a';
  const r = 1.2 / cam.s;
  for (let x = Math.floor(cam.x / step) * step; x < cam.x + W; x += step)
    for (let y = Math.floor(cam.y / step) * step; y < cam.y + H; y += step) ctx.fillRect(x - r, y - r, r * 2, r * 2);
  const V = cur();
  if (!V.components.length && !readOnly()) {
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    label(ctx, 'Empty circuit', cssW / 2, cssH / 2 - 14, 22, '#8a93aa'); label(ctx, 'Pick a folder below, then drag or tap a part to add it.', cssW / 2, cssH / 2 + 14, 15, '#6c7488');
    ctx.restore();
  }
  // wires
  for (const w of V.wires) {
    const pts = wirePath(sim, V.map, w); if (!pts) continue;
    drawWire(ctx, pts, sim.pinValue(w.a.c, w.a.p), pinWidth(w.a), w.id === selectedWire, sim.badWires.has(w.id));
  }
  for (const c of V.components) drawComponent(ctx, c, sim, c.id === selected);
  // pins: dots, hollow orange ring on unconnected inputs, bus-width / bit-range labels
  const wired = new Set<string>();
  for (const w of V.wires) { wired.add(w.a.c + ':' + w.a.p); wired.add(w.b.c + ':' + w.b.p); }
  for (const c of V.components) pinsOf(c).forEach((p, pi) => {
    const q = pinWorld(c, p), r = (p.width > 1 ? 4.5 : 3.5) * (coarse ? 1.25 : 1);
    const open = p.dir === 'in' && c.type !== 'PORT' && !wired.has(c.id + ':' + pi);
    ctx.beginPath(); ctx.arc(q.x, q.y, open ? r + 0.5 : r, 0, Math.PI * 2);
    if (open) { ctx.fillStyle = '#14161c'; ctx.fill(); ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 2; ctx.stroke(); }
    else { ctx.fillStyle = '#c9cedb'; ctx.fill(); }
    const isBus = c.type === 'SPLIT' || c.type === 'MERGE', showName = isBus && p.name !== 'BUS';
    if (cam.s > 0.45 && (p.width > 1 || showName) && c.type !== 'PORT') {
      const d = pinDir(c, p), txt = showName ? p.name : String(p.width);
      label(ctx, txt, d.x !== 0 ? q.x + d.x * 15 : q.x + 12, d.x !== 0 ? q.y - 9 : q.y + d.y * 12, 10, showName ? COL.z : '#9fb4d8');
    }
  });
  // wire being drawn
  if (mode === 'wire' && wireFrom && wireTo) {
    const c = cur().map.get(wireFrom.c)!, p = pinsOf(c)[wireFrom.p];
    let end = wireTo, endDir = null;
    if (wireHover) { const hc = cur().map.get(wireHover.c)!, hp = pinsOf(hc)[wireHover.p]; end = pinWorld(hc, hp); endDir = pinDir(hc, hp); }
    const pts = routeBetween(pinWorld(c, p), pinDir(c, p), end, endDir);
    ctx.save(); ctx.globalAlpha = 0.8;
    drawWire(ctx, pts, sim.pinValue(wireFrom.c, wireFrom.p), p.width, true, !!wireHover && pinWidth(wireHover) !== p.width);
    ctx.restore();
    if (wireHover) { ctx.beginPath(); ctx.arc(end.x, end.y, 9, 0, Math.PI * 2); ctx.strokeStyle = pinWidth(wireHover) === p.width ? COL.sel : COL.x; ctx.lineWidth = 2; ctx.stroke(); }
  }
  // live value popup
  if (inspect) {
    let bits, title;
    if (inspect.kind === 'wire') {
      const w = V.wires.find((x) => x.id === (inspect as { id: string }).id);
      if (!w) { hidePopup(); return; }
      bits = sim.pinValue(w.a.c, w.a.p); title = `${bits.length}-bit wire`;
    } else {
      const c = V.map.get(inspect.ref.c); if (!c) { hidePopup(); return; }
      bits = sim.pinValue(c.id, inspect.ref.p); title = `${PARTS[c.type].label}.${pinsOf(c)[inspect.ref.p].name}${pinsOf(c)[inspect.ref.p].dir === 'in' && !wired.has(c.id + ':' + inspect.ref.p) ? ' (not connected)' : ''}`;
    }
    const conflict = bits.some((b) => b === 3);
    popup.textContent = `${title}\n${formatBits(bits)}${conflict ? '\n⚠ conflict / unknown' : bits.every((b) => b === 2) ? '\n(floating)' : ''}`;
    popup.style.left = Math.min(inspect.sx + 14, innerWidth - 220) + 'px'; popup.style.top = Math.max(inspect.sy - 50, 50) + 'px';
  }
}

// debugging / automation hook
(window as unknown as { logicsim: unknown }).logicsim = { get circuit() { return circuit; }, get sim() { return sim; }, cam, fit, rebuild, openChip, closeChip, pinPos: (id: string, p: number) => { const c = cur().map.get(id)!; const q = pinWorld(c, pinsOf(c)[p]); const r = canvas.getBoundingClientRect(); return { x: r.left + (q.x - cam.x) * cam.s, y: r.top + (q.y - cam.y) * cam.s }; }, compPos: (id: string) => { const c = cur().map.get(id)!; const r = canvas.getBoundingClientRect(); return { x: r.left + (c.x - cam.x) * cam.s, y: r.top + (c.y - cam.y) * cam.s }; } };
init();
