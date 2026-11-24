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

const INPUT: PartDef = {
  type: 'IN', label: 'Input', hasWidth: true, maxWidth: 32, delay: 1,
  size: (p) => ({ w: width(p) > 1 ? 80 : 40, h: 40 }),
  pins: (p) => [{ name: 'Q', dir: 'out', width: width(p), x: width(p) > 1 ? 80 : 40, y: 20 }],
  eval(_ins, outs, comp) {
    const v = comp.props.value ?? 0, q = outs[0];
    for (let i = 0; i < q.length; i++) q[i] = ((v >>> i) & 1) as Bit;
  },
};

const OUTPUT: PartDef = {
  type: 'OUT', label: 'LED', hasWidth: true, maxWidth: 32, delay: 1,
  size: (p) => ({ w: width(p) > 1 ? 80 : 40, h: 40 }),
  pins: (p) => [{ name: 'A', dir: 'in', width: width(p), x: 0, y: 20 }],
};

const SPLIT: PartDef = {
  type: 'SPLIT', label: 'Splitter', hasWidth: true, maxWidth: 32, delay: 0,
  size: (p) => ({ w: 40, h: Math.max(40, width(p) * 20) }),
  pins: (p) => {
    const n = width(p), h = Math.max(40, n * 20);
    const pins: PinDef[] = [{ name: 'BUS', dir: 'in', width: n, x: 0, y: h / 2 }];
    for (let i = 0; i < n; i++) pins.push({ name: 'b' + i, dir: 'out', width: 1, x: 40, y: h - 10 - i * 20 - (h - n * 20) / 2 });
    return pins;
  },
  alias: (p) => Array.from({ length: width(p) }, (_, i) => [0, i, 1 + i, 0] as [number, number, number, number]),
};

const MERGE: PartDef = {
  type: 'MERGE', label: 'Merger', hasWidth: true, maxWidth: 32, delay: 0,
  size: (p) => ({ w: 40, h: Math.max(40, width(p) * 20) }),
  pins: (p) => {
    const n = width(p), h = Math.max(40, n * 20);
    const pins: PinDef[] = [];
    for (let i = 0; i < n; i++) pins.push({ name: 'b' + i, dir: 'in', width: 1, x: 0, y: h - 10 - i * 20 - (h - n * 20) / 2 });
    pins.push({ name: 'BUS', dir: 'out', width: n, x: 40, y: h / 2 });
    return pins;
  },
  alias: (p) => Array.from({ length: width(p) }, (_, i) => [i, 0, width(p), i] as [number, number, number, number]),
};

/** Chip boundary pin, only used inside chip definitions (pure wiring, zero delay). */
const PORT: PartDef = {
  type: 'PORT', label: 'Port', hasWidth: true, maxWidth: 32, delay: 0,
  size: () => ({ w: 40, h: 40 }),
  pins: (p) => [{ name: p.label ?? 'P', dir: p.dir === 'out' ? 'in' : 'out', width: width(p), x: p.dir === 'out' ? 0 : 40, y: 20 }],
};

export const PARTS: Record<string, PartDef> = { NAND, TRI, IN: INPUT, OUT: OUTPUT, SPLIT, MERGE, PORT };

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
