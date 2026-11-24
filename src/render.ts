import { PARTS, PinDef, cellW, pinDir, pinWorld } from './engine/parts';
import { Sim } from './engine/sim';
import { Bit, Component, V0, V1, VX, VZ, Wire } from './engine/types';

export const COL = { off: '#4a5268', on: '#4cc38a', z: '#9aa0b0', x: '#ff5a5a', body: '#2b303d', stroke: '#c9cedb', sel: '#5aa9ff' };

export function bitsState(bits: Bit[]): 'on' | 'off' | 'z' | 'x' {
  if (!bits.length) return 'z';
  if (bits.some((b) => b === VX)) return 'x';
  if (bits.every((b) => b === VZ)) return 'z';
  return bits.some((b) => b === V1) ? 'on' : 'off';
}
export const stateColor = (s: ReturnType<typeof bitsState>) => COL[s];

export function formatBits(bits: Bit[]): string {
  const s = bits.slice().reverse().map((b) => (b === 0 ? '0' : b === 1 ? '1' : b === 2 ? 'Z' : 'X')).join('');
  if (bits.length === 1) return s;
  const known = bits.every((b) => b < 2);
  const v = known ? bits.reduce<number>((a, b, i) => a + b * 2 ** i, 0) : NaN;
  return known ? `${s}  = ${v} (0x${v.toString(16).toUpperCase()})` : s;
}

/** Orthogonal route between two pins: out along each pin's direction, then an elbow. */
export function wirePath(sim: Sim | null, comps: Map<string, Component>, w: Wire): { x: number; y: number }[] | null {
  const ca = comps.get(w.a.c), cb = comps.get(w.b.c);
  if (!ca || !cb) return null;
  const pa = PARTS[ca.type].pins(ca.props)[w.a.p], pb = PARTS[cb.type].pins(cb.props)[w.b.p];
  if (!pa || !pb) return null;
  return routeBetween(pinWorld(ca, pa), pinDir(ca, pa), pinWorld(cb, pb), pinDir(cb, pb));
}
export function routeBetween(a: { x: number; y: number }, da: { x: number; y: number }, b: { x: number; y: number }, db: { x: number; y: number } | null) {
  const S = 10;
  const a1 = { x: a.x + da.x * S, y: a.y + da.y * S };
  const b1 = db ? { x: b.x + db.x * S, y: b.y + db.y * S } : b;
  const pts = [a, a1];
  if (da.x !== 0) { const mx = (a1.x + b1.x) / 2; pts.push({ x: mx, y: a1.y }, { x: mx, y: b1.y }); }
  else { const my = (a1.y + b1.y) / 2; pts.push({ x: a1.x, y: my }, { x: b1.x, y: my }); }
  pts.push(b1, b);
  return pts;
}

export function drawWire(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], bits: Bit[], width: number, highlight: boolean, bad: boolean) {
  const st = bad ? 'x' : bitsState(bits);
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const lw = width > 1 ? 5 : 3;
  if (highlight) { ctx.strokeStyle = COL.sel + '88'; ctx.lineWidth = lw + 6; stroke(ctx, pts); }
  ctx.strokeStyle = stateColor(st); ctx.lineWidth = lw;
  if (st === 'z' || bad) ctx.setLineDash([6, 6]);
  stroke(ctx, pts);
  if (width > 1) { ctx.setLineDash([]); ctx.strokeStyle = '#14161c'; ctx.lineWidth = 1; stroke(ctx, pts); }
  ctx.restore();
}
function stroke(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
}

export function drawComponent(ctx: CanvasRenderingContext2D, c: Component, sim: Sim | null, selected: boolean) {
  const def = PARTS[c.type];
  const s = def.size(c.props);
  const pins = def.pins(c.props);
  const val = (pi: number) => sim?.pinValue(c.id, pi) ?? [];
  /** Bits for value displays; tray icons (no sim) show all zeros. */
  const bitsFor = (pi: number): Bit[] => (sim ? val(pi) : (Array(pins[pi].width).fill(0) as Bit[]));
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate((c.rot & 3) * Math.PI / 2);
  ctx.translate(-s.w / 2, -s.h / 2);
  ctx.lineWidth = 2; ctx.strokeStyle = selected ? COL.sel : COL.stroke; ctx.fillStyle = COL.body;
  // pin stubs
  pins.forEach((p, pi) => {
    const st = bitsState(val(pi));
    ctx.save(); ctx.strokeStyle = stateColor(st); ctx.lineWidth = p.width > 1 ? 5 : 3;
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
    const inward = stubInward(p, s);
    const sh = def.symbol?.shape;
    const len = p.dir === 'in' && sh === 'or' ? 14 : p.dir === 'in' && sh === 'xor' ? 9 : p.dir === 'out' && def.symbol && !def.symbol.bubble ? (sh === 'buf' ? 26 : 20) : c.type === 'SPLIT' ? (p.dir === 'in' ? 12 : 22) : c.type === 'MERGE' ? (p.dir === 'in' ? 22 : 12) : 10;
    ctx.lineTo(p.x + inward.x * len, p.y + inward.y * len); ctx.stroke(); ctx.restore();
  });
  if (def.symbol) {
    drawGate(ctx, def.symbol.shape, def.symbol.bubble, s.h);
    if ((c.props.width ?? 1) > 1) label(ctx, String(c.props.width), def.symbol.shape === 'buf' ? 22 : 30, s.h / 2, 11, COL.stroke);
  } else if (def.chip) {
    rr(ctx, 10, 2, s.w - 20, s.h - 4, 6); ctx.fill(); ctx.stroke(); label(ctx, def.label, s.w / 2, s.h / 2, 12, COL.stroke);
  }
  switch (c.type) {
    case 'TRI': {
      ctx.beginPath(); ctx.moveTo(10, 4); ctx.lineTo(50, 20); ctx.lineTo(10, 36); ctx.closePath(); ctx.fill(); ctx.stroke();
      label(ctx, 'EN', 22, 20, 9, COL.stroke);
      break;
    }
    case 'IN': {
      const bits = bitsFor(0), st = bitsState(bits);
      rr(ctx, 2, 2, s.w - 12, s.h - 4, 8); ctx.fill(); ctx.stroke();
      if (bits.length <= 1) {
        ctx.beginPath(); ctx.arc(15, 20, 11, 0, Math.PI * 2); ctx.fillStyle = stateColor(st); ctx.fill();
      } else {
        cells(ctx, bits, 6, 6, cellW(bits.length), '#4cc38a', '#3a4256');
        label(ctx, valueText(bits), 2 + (s.w - 12) / 2, 32, 10, COL.stroke);
      }
      break;
    }
    case 'OUT': {
      const bits = bitsFor(0), st = bitsState(bits);
      if (bits.length <= 1) {
        ctx.beginPath(); ctx.arc(24, 20, 14, 0, Math.PI * 2);
        ctx.fillStyle = st === 'on' ? '#ff5a3c' : st === 'x' ? COL.x : '#3a2a2a'; ctx.fill();
        if (st === 'z') ctx.setLineDash([3, 3]);
        ctx.stroke(); ctx.setLineDash([]);
        if (st === 'z') label(ctx, 'Z', 24, 20, 11, COL.z);
        if (st === 'x') label(ctx, '!', 24, 20, 14, '#fff');
        if (st === 'on') { ctx.save(); ctx.globalAlpha = .35; ctx.beginPath(); ctx.arc(24, 20, 19, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
      } else {
        rr(ctx, 10, 2, s.w - 12, s.h - 4, 8); ctx.fill(); ctx.stroke();
        cells(ctx, bits, 14, 6, cellW(bits.length), '#ff5a3c', '#3a2a2a');
        label(ctx, valueText(bits), 10 + (s.w - 12) / 2, 32, 10, COL.stroke);
      }
      break;
    }
    case 'CONST': {
      const bits = bitsFor(0), st = bitsState(bits), v = c.props.value ?? 0;
      rr(ctx, 2, 2, s.w - 12, s.h - 4, 8); ctx.fill(); ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
      if ((c.props.width ?? 1) <= 1) label(ctx, v ? '1' : '0', (s.w - 10) / 2, 21, 20, v ? COL.on : '#8a93aa');
      else label(ctx, '0x' + v.toString(16).toUpperCase(), (s.w - 10) / 2, 21, 14, stateColor(st === 'z' ? 'off' : st));
      break;
    }
    case 'HEX': {
      const bits = bitsFor(0);
      rr(ctx, 10, 2, s.w - 12, s.h - 4, 8); ctx.fillStyle = '#0d0f14'; ctx.fill(); ctx.fillStyle = COL.body; ctx.stroke();
      label(ctx, displayText(bits, c.props.fmt ?? 'hex'), 10 + (s.w - 12) / 2, s.h / 2 + 1, 22, bits.some((b) => b === VX) ? COL.x : bits.some((b) => b === VZ) ? COL.z : '#7dffb0', 'ui-monospace, Menlo, monospace');
      break;
    }
    case 'SEG7': {
      rr(ctx, 10, 2, s.w - 12, s.h - 4, 8); ctx.fillStyle = '#0d0f14'; ctx.fill(); ctx.fillStyle = COL.body; ctx.stroke();
      const on = (i: number) => val(i)[0] === 1;
      const segs: Array<[number, number, number, number]> = [[40, 16, 24, 6], [66, 24, 6, 46], [66, 80, 6, 46], [40, 128, 24, 6], [32, 80, 6, 46], [32, 24, 6, 46], [40, 72, 24, 6]];
      segs.forEach((g, i) => { ctx.fillStyle = on(i) ? '#ff5a3c' : '#2a2326'; ctx.fillRect(...g); });
      for (let i = 0; i < 7; i++) label(ctx, 'abcdefg'[i], 20, 15 + i * 20, 10, COL.z);
      break;
    }
    case 'PORT': {
      rr(ctx, c.props.dir === 'out' ? 10 : 2, 4, 28, 32, 6); ctx.fillStyle = '#20242e'; ctx.fill(); ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      const st = bitsState(val(0));
      ctx.beginPath(); ctx.arc(c.props.dir === 'out' ? 24 : 16, 20, 7, 0, Math.PI * 2); ctx.fillStyle = stateColor(st); ctx.fill();
      break;
    }
    case 'SPLIT': case 'MERGE': {
      const bx = c.type === 'SPLIT' ? 12 : 22;
      ctx.fillStyle = COL.stroke; ctx.fillRect(bx, 4, 6, s.h - 8);
      break;
    }
  }
  ctx.restore();
  if (c.props.label) {
    const r = c.rot % 2 ? s.w : s.h;
    label(ctx, c.props.label, c.x, c.y - r / 2 - 9, 12, '#c9cedb');
  }
}
function stubInward(p: PinDef, s: { w: number; h: number }) {
  if (p.x <= 0) return { x: 1, y: 0 };
  if (p.x >= s.w) return { x: -1, y: 0 };
  return p.y <= 0 ? { x: 0, y: 1 } : { x: 0, y: -1 };
}
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}
export function label(ctx: CanvasRenderingContext2D, t: string, x: number, y: number, size: number, color: string, family = '-apple-system, system-ui, sans-serif') {
  ctx.save(); ctx.fillStyle = color; ctx.font = `600 ${size}px ${family}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y); ctx.restore();
}

/** Standard gate symbols in an 80 x h box: inputs on the left (x=0), output at x=80. */
function drawGate(ctx: CanvasRenderingContext2D, shape: 'and' | 'or' | 'xor' | 'buf', bubble: boolean, h: number) {
  const m = h / 2, t = m - 18, b = m + 18;
  ctx.beginPath();
  let tip = 60;
  if (shape === 'and') { ctx.moveTo(10, t); ctx.lineTo(42, t); ctx.arc(42, m, 18, -Math.PI / 2, Math.PI / 2); ctx.lineTo(10, b); ctx.closePath(); }
  else if (shape === 'buf') { tip = 54; ctx.moveTo(12, m - 16); ctx.lineTo(tip, m); ctx.lineTo(12, m + 16); ctx.closePath(); }
  else {
    const x0 = shape === 'xor' ? 14 : 10; tip = 62;
    ctx.moveTo(x0, t); ctx.quadraticCurveTo(x0 + 34, t, tip, m); ctx.quadraticCurveTo(x0 + 34, b, x0, b); ctx.quadraticCurveTo(x0 + 12, m, x0, t); ctx.closePath();
  }
  ctx.fill(); ctx.stroke();
  if (shape === 'xor') { ctx.beginPath(); ctx.moveTo(7, t); ctx.quadraticCurveTo(19, m, 7, b); ctx.stroke(); }
  if (bubble) { ctx.beginPath(); ctx.arc(tip + 5, m, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
}

/** Row of bit cells, most significant bit on the left. */
function cells(ctx: CanvasRenderingContext2D, bits: Bit[], x0: number, y0: number, cw: number, onFill: string, offFill: string) {
  const n = bits.length;
  for (let k = 0; k < n; k++) {
    const b = bits[n - 1 - k], x = x0 + k * cw;
    ctx.save();
    ctx.fillStyle = b === V1 ? onFill : b === VX ? COL.x : offFill;
    ctx.beginPath(); ctx.roundRect(x + 1, y0, cw - 2, 18, 3); ctx.fill();
    if (b === VZ) { ctx.setLineDash([2, 2]); ctx.strokeStyle = COL.z; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.restore();
    label(ctx, b === V1 ? '1' : b === V0 ? '0' : b === VZ ? 'Z' : 'X', x + cw / 2, y0 + 10, cw >= 18 ? 12 : 10, b === V1 ? '#10141a' : '#c9cedb');
  }
}
/** "0xA5 · 165" or Z / X when not fully known. */
export function valueText(bits: Bit[]): string {
  if (bits.some((b) => b === VX)) return 'X';
  if (bits.some((b) => b === VZ)) return bits.every((b) => b === VZ) ? 'Z' : 'partly Z';
  const v = bits.reduce<number>((a, b, i) => a + b * 2 ** i, 0);
  return `0x${v.toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), '0')} · ${v}`;
}
/** Text for the numeric display: one char per hex digit (X/Z shown per digit), or decimal. */
export function displayText(bits: Bit[], fmt: 'hex' | 'dec'): string {
  const digits = Math.ceil(bits.length / 4);
  if (fmt === 'dec') {
    if (bits.some((b) => b === VX)) return 'X'; if (bits.some((b) => b === VZ)) return 'Z';
    return String(bits.reduce<number>((a, b, i) => a + b * 2 ** i, 0));
  }
  let out = '';
  for (let d = digits - 1; d >= 0; d--) {
    const nib = bits.slice(d * 4, d * 4 + 4);
    out += nib.some((b) => b === VX) ? 'X' : nib.some((b) => b === VZ) ? 'Z' : nib.reduce<number>((a, b, i) => a + b * 2 ** i, 0).toString(16).toUpperCase();
  }
  return out;
}
