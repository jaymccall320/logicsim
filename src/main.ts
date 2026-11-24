import './style.css';
import { PARTS, pinDir, pinWorld, rotatedSize, width } from './engine/parts';
import { Sim } from './engine/sim';
import { Circuit, Component, PinRef, Wire } from './engine/types';
import { drawComponent, drawWire, formatBits, routeBetween, wirePath, COL } from './render';
import { load, save } from './storage';
import { sampleCircuit } from './sample';

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
function pushUndo() { undoStack.push(JSON.stringify(circuit)); if (undoStack.length > 100) undoStack.shift(); }
function undo() { if (readOnly()) return; const s = undoStack.pop(); if (s) { circuit = JSON.parse(s); rebuild(); } }

// ---------------- persistence ----------------
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save('autosave', { circuit, cam }).catch(console.warn), 400);
}
async function init() {
  const params = new URLSearchParams(location.search);
  let saved: { circuit: Circuit; cam: typeof cam } | undefined;
  if (!params.has('sample')) { try { saved = await load('autosave'); } catch (e) { console.warn(e); } }
  circuit = saved?.circuit?.components ? saved.circuit : sampleCircuit();
  rebuild();
  resize(); fit();
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
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const c = JSON.parse(await f.text()) as Circuit;
    if (!Array.isArray(c.components) || !Array.isArray(c.wires)) throw new Error('not a circuit file');
    pushUndo(); circuit = { version: 1, components: c.components, wires: c.wires }; sim = new Sim({ version: 1, components: [], wires: [] }); rebuild(); fit();
  } catch (err) { alert('Could not import: ' + err); }
  (e.target as HTMLInputElement).value = '';
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
function addPart(type: string, at: Pt, props?: Component['props']) {
  if (readOnly()) return;
  pushUndo();
  const c: Component = { id: uid(), type, x: snap(at.x), y: snap(at.y), rot: 0, props: { ...(type === 'IN' ? { value: 0 } : {}), ...props } };
  circuit.components.push(c); selected = c.id; rebuild();
}
function addWire(a: PinRef, b: PinRef) {
  if (a.c === b.c && a.p === b.p) return;
  const dup = circuit.wires.some((w) => (same(w.a, a) && same(w.b, b)) || (same(w.a, b) && same(w.b, a)));
  if (dup) return;
  if (pinWidth(a) !== pinWidth(b)) { flash(`Width mismatch: ${pinWidth(a)}-bit vs ${pinWidth(b)}-bit`); return; }
  pushUndo(); circuit.wires.push({ id: uid(), a, b }); rebuild();
}
const same = (x: PinRef, y: PinRef) => x.c === y.c && x.p === y.p;
function toggleInput(c: Component) {
  const w = width(c.props), max = 2 ** w;
  c.props.value = w === 1 ? (c.props.value ? 0 : 1) : ((c.props.value ?? 0) + 1) % max;
  sim.touch(c.id); scheduleSave();
}
function deleteComp(id: string) {
  pushUndo(); circuit.components = circuit.components.filter((c) => c.id !== id);
  if (selected === id) selected = null; rebuild();
}
function deleteWire(id: string) { pushUndo(); circuit.wires = circuit.wires.filter((w) => w.id !== id); rebuild(); }
function setWidth(c: Component, w: number) {
  const max = PARTS[c.type].maxWidth; w = Math.max(1, Math.min(max, w));
  if (w === width(c.props)) return;
  pushUndo(); c.props.width = w; if (c.type === 'IN') c.props.value = (c.props.value ?? 0) % 2 ** w;
  // drop wires whose pins vanished or no longer match in width
  circuit.wires = circuit.wires.filter((wr) => {
    const ca = circuit.components.find((x) => x.id === wr.a.c), cb = circuit.components.find((x) => x.id === wr.b.c);
    const pa = ca && pinsOf(ca)[wr.a.p], pb = cb && pinsOf(cb)[wr.b.p];
    return pa && pb && pa.width === pb.width;
  });
  rebuild();
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
let flashTimer = 0;
function flash(msg: string) {
  const st = $('status'); st.textContent = msg; st.style.color = COL.x;
  clearTimeout(flashTimer); flashTimer = window.setTimeout(() => (st.style.color = ''), 2500);
  lastStatus = performance.now() + 2500;
}

// ---------------- context menu ----------------
function closeMenu() { menu.hidden = true; menu.innerHTML = ''; }
function openMenu(sx: number, sy: number, target: { comp?: Component; wire?: Wire }) {
  closeMenu(); hidePopup();
  const btn = (text: string, fn: () => void, cls = '') => {
    const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls;
    b.addEventListener('pointerup', (e) => { e.stopPropagation(); fn(); closeMenu(); });
    return b;
  };
  if (target.comp) {
    const c = target.comp, def = PARTS[c.type];
    const h = document.createElement('div'); h.className = 'row'; h.innerHTML = `<span>${def.label}${c.props.label ? ' · ' + c.props.label : ''}</span>`; menu.append(h);
    if (def.chip) menu.append(btn('🔍 Look inside', () => openChip(c)));
    if (readOnly()) { menu.hidden = false; placeMenu(sx, sy); return; }
    menu.append(btn('⟳ Rotate', () => { pushUndo(); c.rot = (c.rot + 1) & 3; rebuild(); }));
    if (def.hasWidth) {
      const row = document.createElement('div'); row.className = 'row';
      const lab = document.createElement('span'); lab.textContent = `Width ${width(c.props)}`;
      const minus = btn('−', () => setWidth(c, width(c.props) === 8 ? 4 : width(c.props) === 16 ? 8 : width(c.props) - 1));
      const plus = btn('+', () => setWidth(c, width(c.props) >= 8 ? width(c.props) * 2 : width(c.props) === 4 ? 8 : width(c.props) + 1));
      row.append(lab, minus, plus); menu.append(row);
    }
    if (c.type === 'IN' || c.type === 'OUT') menu.append(btn('✎ Label', () => {
      const t = prompt('Label', c.props.label ?? ''); if (t !== null) { pushUndo(); c.props.label = t || undefined; rebuild(); }
    }));
    if (c.type === 'IN' && width(c.props) > 1) menu.append(btn('# Set value', () => {
      const t = prompt('Value (decimal or 0x / 0b)', String(c.props.value ?? 0));
      if (t !== null) { const v = Number(t); if (Number.isFinite(v)) { c.props.value = (v >>> 0) % 2 ** width(c.props); sim.touch(c.id); scheduleSave(); } }
    }));
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
  if (pin && !(comp && comp.id !== pin.c && false)) {
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
        if (c.type === 'IN' && !readOnly()) toggleInput(c);
        else { inspect = { kind: 'pin', ref: wireFrom!, sx: e.clientX, sy: e.clientY }; popup.hidden = false; }
      }
      wireFrom = null; wireTo = null; wireHover = null; break;
    case 'press-comp':
      selected = target!.id; hidePopup();
      if (target!.type === 'IN' && !readOnly()) toggleInput(target!);
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
  else if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); undo(); }
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});

// ---------------- parts tray (folders) ----------------
interface TrayItem { type: string; label?: string; props?: Component['props'] }
interface Folder { id: string; name: string; items: () => TrayItem[]; empty?: string }
const FOLDERS: Folder[] = [
  { id: 'gates', name: 'Gates', items: () => ['NAND', 'NOT', 'AND', 'OR', 'NOR', 'XOR', 'XNOR', 'BUF'].map((type) => ({ type })) },
  { id: 'conn', name: 'Connectors', items: () => [{ type: 'SPLIT', props: { width: 4 } }, { type: 'MERGE', props: { width: 4 } }, { type: 'TRI', label: 'Tri-state' }] },
  { id: 'in', name: 'Inputs', items: () => [{ type: 'IN', label: 'Switch', props: { value: 0 } }, { type: 'IN', label: '4-bit In', props: { width: 4, value: 0 } }, { type: 'IN', label: '8-bit In', props: { width: 8, value: 0 } }] },
  { id: 'out', name: 'Outputs', items: () => [{ type: 'OUT', label: 'LED' }, { type: 'OUT', label: '4-bit Out', props: { width: 4 } }, { type: 'OUT', label: '8-bit Out', props: { width: 8 } }] },
  { id: 'custom', name: 'Custom Chips', items: () => Object.values(PARTS).filter((d) => d.chip && !d.chip.builtin).map((d) => ({ type: d.type })),
    empty: 'No custom chips yet. Soon you will select part of a circuit and save it as a chip, and it will appear here.' },
];
const tabsEl = $('tabs'), partsEl = $('parts');
let folder = localStorage.getItem('logicsim.folder') ?? 'gates';
if (!FOLDERS.some((f) => f.id === folder)) folder = 'gates';
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const f of FOLDERS) {
    const b = document.createElement('button'); b.className = 'tab' + (f.id === folder ? ' active' : ''); b.textContent = f.name;
    b.dataset.folder = f.id;
    b.addEventListener('click', () => { folder = f.id; localStorage.setItem('logicsim.folder', folder); renderTabs(); renderParts(); });
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
  const demoProps = type === 'SPLIT' || type === 'MERGE' ? { width: 2 } : { ...item.props };
  const demo: Component = { id: 'icon', type, x: 0, y: 0, rot: 0, props: demoProps };
  const s = def.size(demo.props), k = Math.min(76 / s.w, 40 / s.h);
  ic.translate(42, 22); ic.scale(k, k); drawComponent(ic, demo, null, false);
  const name = document.createElement('span'); name.textContent = item.label ?? def.label;
  el.append(icon, name);
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
    } else if (e.type === 'pointerup') addPart(type, toWorld(r.width / 2 + (Math.random() - .5) * 60, r.height / 2 + (Math.random() - .5) * 60), item.props);
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
  hidePopup(); updateViewUI();
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
$('fit').addEventListener('click', fit);
$('export').addEventListener('click', exportFile);
$('import').addEventListener('click', () => $('file').click());
$('clear').addEventListener('click', () => {
  if (!confirm('Start a new empty circuit? (Undo can bring it back.)')) return;
  pushUndo(); circuit = { version: 1, components: [], wires: [] }; rebuild();
});

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
  // wires
  const V = cur();
  for (const w of V.wires) {
    const pts = wirePath(sim, V.map, w); if (!pts) continue;
    drawWire(ctx, pts, sim.pinValue(w.a.c, w.a.p), pinWidth(w.a), w.id === selectedWire, sim.badWires.has(w.id));
  }
  for (const c of V.components) drawComponent(ctx, c, sim, c.id === selected);
  // pins
  for (const c of V.components) pinsOf(c).forEach((p, pi) => {
    const q = pinWorld(c, p);
    ctx.beginPath(); ctx.arc(q.x, q.y, (p.width > 1 ? 4.5 : 3.5) * (coarse ? 1.25 : 1), 0, Math.PI * 2);
    ctx.fillStyle = '#c9cedb'; ctx.fill();
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
    if (wireHover) { ctx.beginPath(); ctx.arc(end.x, end.y, 9, 0, Math.PI * 2); ctx.strokeStyle = COL.sel; ctx.lineWidth = 2; ctx.stroke(); }
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
      bits = sim.pinValue(c.id, inspect.ref.p); title = `${PARTS[c.type].label}.${pinsOf(c)[inspect.ref.p].name}`;
    }
    const conflict = bits.some((b) => b === 3);
    popup.textContent = `${title}\n${formatBits(bits)}${conflict ? '\n⚠ conflict / unknown' : bits.every((b) => b === 2) ? '\n(floating)' : ''}`;
    popup.style.left = Math.min(inspect.sx + 14, innerWidth - 220) + 'px'; popup.style.top = Math.max(inspect.sy - 50, 50) + 'px';
  }
}

// debugging / automation hook
(window as unknown as { logicsim: unknown }).logicsim = { get circuit() { return circuit; }, get sim() { return sim; }, cam, fit, rebuild, openChip, closeChip };
init();
