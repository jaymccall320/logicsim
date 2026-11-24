import { Bit, Component, Props, V0, V1, VX, VZ } from './types';

export interface PinDef {
  name: string;
  dir: 'in' | 'out';
  width: number;
  x: number; // local coords, origin = top-left of unrotated body
  y: number;
}

export interface PartDef {
  type: string;
  label: string;
  hasWidth: boolean;
  maxWidth: number;
  delay: number;
  size(p: Props): { w: number; h: number };
  pins(p: Props): PinDef[];
  /** Compute output bits from input bits. ins/outs indexed by in-pin / out-pin order. */
  eval?(ins: Bit[][], outs: Bit[][], comp: Component): void;
  /** Pure wiring parts (splitter/merger) alias bits instead of evaluating: [pinA, bitA, pinB, bitB]. */
  alias?(p: Props): Array<[number, number, number, number]>;
  /** Composite part: flattened into its internal circuit before simulation. */
  chip?: import('./chips').ChipDef;
  /** Drawing style for gate symbols. */
  symbol?: { shape: 'and' | 'or' | 'xor' | 'buf'; bubble: boolean };
}

export const width = (p: Props) => Math.max(1, Math.min(32, p.width ?? 1));
const inBit = (b: Bit): Bit => (b === VZ ? V0 : b); // floating gate inputs read as 0 (pull-down)

const NAND: PartDef = {
  type: 'NAND', label: 'NAND', hasWidth: true, maxWidth: 32, delay: 1, symbol: { shape: 'and', bubble: true },
  size: () => ({ w: 80, h: 40 }),
  pins: (p) => [
    { name: 'A', dir: 'in', width: width(p), x: 0, y: 10 },
    { name: 'B', dir: 'in', width: width(p), x: 0, y: 30 },
    { name: 'Q', dir: 'out', width: width(p), x: 80, y: 20 },
  ],
  eval(ins, outs) {
    const a = ins[0], b = ins[1], q = outs[0];
    for (let i = 0; i < q.length; i++) {
      const x = inBit(a[i]), y = inBit(b[i]);
      q[i] = x === V0 || y === V0 ? V1 : x === V1 && y === V1 ? V0 : VX;
    }
  },
};

const TRI: PartDef = {
  type: 'TRI', label: 'Tri-state', hasWidth: true, maxWidth: 32, delay: 1,
  size: () => ({ w: 60, h: 40 }),
  pins: (p) => [
    { name: 'D', dir: 'in', width: width(p), x: 0, y: 20 },
    { name: 'EN', dir: 'in', width: 1, x: 30, y: 40 },
    { name: 'Q', dir: 'out', width: width(p), x: 60, y: 20 },
  ],
  eval(ins, outs) {
    const d = ins[0], en = inBit(ins[1][0]), q = outs[0];
    for (let i = 0; i < q.length; i++) q[i] = en === V0 ? VZ : en === V1 ? inBit(d[i]) : VX;
  },
};

/** Width of one bit cell on multi-bit switches / LED rows. */
export const cellW = (n: number) => (n <= 8 ? 22 : n <= 16 ? 18 : 14);
const busBody = (n: number) => (n > 1 ? n * cellW(n) + 8 : 28);

const INPUT: PartDef = {
  type: 'IN', label: 'Input', hasWidth: true, maxWidth: 32, delay: 1,
  size: (p) => ({ w: width(p) > 1 ? busBody(width(p)) + 12 : 40, h: 40 }),
  pins: (p) => [{ name: 'Q', dir: 'out', width: width(p), x: width(p) > 1 ? busBody(width(p)) + 12 : 40, y: 20 }],
  eval(_ins, outs, comp) {
    const v = comp.props.value ?? 0, q = outs[0];
    for (let i = 0; i < q.length; i++) q[i] = (Math.floor(v / 2 ** i) % 2) as Bit;
  },
};

/** Constant (tie-high / tie-low / fixed bus value). Same output as an input pin but not tappable. */
const CONST: PartDef = {
  type: 'CONST', label: 'Constant', hasWidth: true, maxWidth: 32, delay: 1,
  size: (p) => ({ w: width(p) > 1 ? Math.max(70, Math.ceil(width(p) / 4) * 14 + 52) : 40, h: 40 }),
  pins: (p) => [{ name: 'Q', dir: 'out', width: width(p), x: width(p) > 1 ? Math.max(70, Math.ceil(width(p) / 4) * 14 + 52) : 40, y: 20 }],
  eval: INPUT.eval,
};

const OUTPUT: PartDef = {
  type: 'OUT', label: 'LED', hasWidth: true, maxWidth: 32, delay: 1,
  size: (p) => ({ w: width(p) > 1 ? busBody(width(p)) + 12 : 40, h: 40 }),
  pins: (p) => [{ name: 'A', dir: 'in', width: width(p), x: 0, y: 20 }],
};

/** Numeric display (hex or decimal) for a bus. */
const HEX: PartDef = {
  type: 'HEX', label: 'Hex display', hasWidth: true, maxWidth: 32, delay: 1,
  size: (p) => ({ w: Math.max(64, Math.ceil(width(p) / 4) * 20 + 36), h: 44 }),
  pins: (p) => [{ name: 'A', dir: 'in', width: width(p), x: 0, y: 22 }],
};

/** Seven-segment digit with one pin per segment (a..g), so decoders are built by the user from gates. */
export const SEG_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const SEG7: PartDef = {
  type: 'SEG7', label: '7-segment', hasWidth: false, maxWidth: 1, delay: 1,
  size: () => ({ w: 84, h: 150 }),
  pins: () => SEG_NAMES.map((name, i): PinDef => ({ name, dir: 'in', width: 1, x: 0, y: 15 + i * 20 })),
};

/** Valid group sizes for a splitter/merger, or all-ones when unset / inconsistent (so old saves keep working). */
export function groupsOf(p: Props): number[] {
  const w = width(p), g = p.groups;
  if (Array.isArray(g) && g.length > 0 && g.every((n) => Number.isInteger(n) && n >= 1) && g.reduce((a, b) => a + b, 0) === w) return g;
  return Array.from({ length: w }, () => 1);
}
/** Pin y centres for n pins on a part of height h (pin 0 lowest). */
const groupY = (i: number, n: number, h: number) => h - 10 - i * 20 - (h - n * 20) / 2;
const splitH = (p: Props) => Math.max(40, groupsOf(p).length * 20);
const groupName = (lo: number, n: number) => (n === 1 ? `b${lo}` : `${lo + n - 1}:${lo}`);

const SPLIT: PartDef = {
  type: 'SPLIT', label: 'Splitter', hasWidth: true, maxWidth: 32, delay: 0,
  size: (p) => ({ w: 40, h: splitH(p) }),
  pins: (p) => {
    const g = groupsOf(p), h = splitH(p);
    const pins: PinDef[] = [{ name: 'BUS', dir: 'in', width: width(p), x: 0, y: h / 2 }];
    let lo = 0;
    g.forEach((n, i) => { pins.push({ name: groupName(lo, n), dir: 'out', width: n, x: 40, y: groupY(i, g.length, h) }); lo += n; });
    return pins;
  },
  alias: (p) => {
    const out: Array<[number, number, number, number]> = []; let lo = 0;
    groupsOf(p).forEach((n, i) => { for (let j = 0; j < n; j++) out.push([0, lo + j, 1 + i, j]); lo += n; });
    return out;
  },
};

const MERGE: PartDef = {
  type: 'MERGE', label: 'Merger', hasWidth: true, maxWidth: 32, delay: 0,
  size: (p) => ({ w: 40, h: splitH(p) }),
  pins: (p) => {
    const g = groupsOf(p), h = splitH(p), pins: PinDef[] = []; let lo = 0;
    g.forEach((n, i) => { pins.push({ name: groupName(lo, n), dir: 'in', width: n, x: 0, y: groupY(i, g.length, h) }); lo += n; });
    pins.push({ name: 'BUS', dir: 'out', width: width(p), x: 40, y: h / 2 });
    return pins;
  },
  alias: (p) => {
    const out: Array<[number, number, number, number]> = []; const g = groupsOf(p); let lo = 0;
    g.forEach((n, i) => { for (let j = 0; j < n; j++) out.push([i, j, g.length, lo + j]); lo += n; });
    return out;
  },
};

/** Chip boundary pin, only used inside chip definitions (pure wiring, zero delay). */
const PORT: PartDef = {
  type: 'PORT', label: 'Port', hasWidth: true, maxWidth: 32, delay: 0,
  size: () => ({ w: 40, h: 40 }),
  pins: (p) => [{ name: p.label ?? 'P', dir: p.dir === 'out' ? 'in' : 'out', width: width(p), x: p.dir === 'out' ? 0 : 40, y: 20 }],
};

export const PARTS: Record<string, PartDef> = { NAND, TRI, IN: INPUT, OUT: OUTPUT, CONST, HEX, SEG7, SPLIT, MERGE, PORT };

// ---- geometry (shared by UI; engine itself does not need it) ----
export function rotatedSize(c: Component) {
  const s = PARTS[c.type].size(c.props);
  return c.rot % 2 ? { w: s.h, h: s.w } : s;
}
export function pinWorld(c: Component, pin: PinDef) {
  const s = PARTS[c.type].size(c.props);
  let dx = pin.x - s.w / 2, dy = pin.y - s.h / 2;
  for (let r = 0; r < (c.rot & 3); r++) [dx, dy] = [-dy, dx];
  return { x: c.x + dx, y: c.y + dy };
}
/** Unit vector pointing out of the body at a pin (for wire stubs). */
export function pinDir(c: Component, pin: PinDef) {
  const s = PARTS[c.type].size(c.props);
  let dx = pin.x <= 0 ? -1 : pin.x >= s.w ? 1 : 0;
  let dy = dx === 0 ? (pin.y <= 0 ? -1 : 1) : 0;
  for (let r = 0; r < (c.rot & 3); r++) [dx, dy] = [-dy, dx];
  return { x: dx, y: dy };
}
