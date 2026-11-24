// Composite parts ("chips") built from primitives. A chip is a normal circuit plus PORT components that form
// its boundary: input ports have ids in0..inN, output ports out0..outM, in chip-pin order.
// The simulator flattens chips into their primitives, so every inner NAND keeps its own delay ("realistic" mode).
// Future: user chips register the same way (from a saved selection), and mode 'fast' will compile the inner
// circuit to a truth table / function behind a single eval() instead of flattening.
import { Builder } from './build';
import { PARTS, PartDef, PinDef, width } from './parts';
import { Circuit, PinRef } from './types';

export interface ChipDef {
  type: string;
  label: string;
  inputs: string[];
  outputs: string[];
  circuit: Circuit;
  mode: 'realistic' | 'fast';
  builtin?: boolean;
  symbol?: PartDef['symbol'];
}

export const portId = (chip: ChipDef, pin: number) => (pin < chip.inputs.length ? `in${pin}` : `out${pin - chip.inputs.length}`);

export function registerChip(chip: ChipDef) {
  const n = Math.max(chip.inputs.length, chip.outputs.length);
  const h = Math.max(40, n * 20);
  const ys = (k: number) => Array.from({ length: k }, (_, i) => h / 2 + (i - (k - 1) / 2) * 20);
  const def: PartDef = {
    type: chip.type, label: chip.label, hasWidth: true, maxWidth: 32, delay: 0, chip, symbol: chip.symbol,
    size: () => ({ w: 80, h }),
    pins: (p) => [
      ...ys(chip.inputs.length).map((y, i): PinDef => ({ name: chip.inputs[i], dir: 'in', width: width(p), x: 0, y })),
      ...ys(chip.outputs.length).map((y, i): PinDef => ({ name: chip.outputs[i], dir: 'out', width: width(p), x: 80, y })),
    ],
  };
  PARTS[chip.type] = def;
  return def;
}

// ---- built-in gates, all made of NANDs ----
function gate(type: string, label: string, ins: string[], symbol: ChipDef['symbol'], build: (b: Builder) => void) {
  const b = new Builder();
  ins.forEach((name, i) => b.add('PORT', 0, ins.length === 1 ? 0 : (i - (ins.length - 1) / 2) * 120, { dir: 'in', label: name }, `in${i}`));
  build(b);
  registerChip({ type, label, inputs: ins, outputs: ['Q'], circuit: b.c, mode: 'realistic', builtin: true, symbol });
}
const N = (b: Builder, id: string, x: number, y: number) => b.add('NAND', x, y, {}, id);
const out = (b: Builder, x: number) => b.add('PORT', x, 0, { dir: 'out', label: 'Q' }, 'out0');

gate('NOT', 'NOT', ['A'], { shape: 'buf', bubble: true }, (b) => {
  N(b, 'n1', 140, 0); out(b, 280);
  b.wire('in0', 0, 'n1', 0); b.wire('in0', 0, 'n1', 1); b.wire('n1', 2, 'out0', 0);
});
gate('BUF', 'Buffer', ['A'], { shape: 'buf', bubble: false }, (b) => {
  N(b, 'n1', 140, 0); N(b, 'n2', 300, 0); out(b, 440);
  b.wire('in0', 0, 'n1', 0); b.wire('in0', 0, 'n1', 1); b.wire('n1', 2, 'n2', 0); b.wire('n1', 2, 'n2', 1); b.wire('n2', 2, 'out0', 0);
});
gate('AND', 'AND', ['A', 'B'], { shape: 'and', bubble: false }, (b) => {
  N(b, 'n1', 140, 0); N(b, 'n2', 300, 0); out(b, 440);
  b.wire('in0', 0, 'n1', 0); b.wire('in1', 0, 'n1', 1); b.wire('n1', 2, 'n2', 0); b.wire('n1', 2, 'n2', 1); b.wire('n2', 2, 'out0', 0);
});
gate('OR', 'OR', ['A', 'B'], { shape: 'or', bubble: false }, (b) => {
  N(b, 'na', 140, -60); N(b, 'nb', 140, 60); N(b, 'n3', 300, 0); out(b, 440);
  b.wire('in0', 0, 'na', 0); b.wire('in0', 0, 'na', 1); b.wire('in1', 0, 'nb', 0); b.wire('in1', 0, 'nb', 1);
  b.wire('na', 2, 'n3', 0); b.wire('nb', 2, 'n3', 1); b.wire('n3', 2, 'out0', 0);
});
gate('XOR', 'XOR', ['A', 'B'], { shape: 'xor', bubble: false }, (b) => {
  N(b, 'n1', 140, 0); N(b, 'n2', 300, -60); N(b, 'n3', 300, 60); N(b, 'n4', 460, 0); out(b, 600);
  b.wire('in0', 0, 'n1', 0); b.wire('in1', 0, 'n1', 1);
  b.wire('in0', 0, 'n2', 0); b.wire('n1', 2, 'n2', 1); b.wire('n1', 2, 'n3', 0); b.wire('in1', 0, 'n3', 1);
  b.wire('n2', 2, 'n4', 0); b.wire('n3', 2, 'n4', 1); b.wire('n4', 2, 'out0', 0);
});
// built from other chips, so "look inside" shows the hierarchy
gate('NOR', 'NOR', ['A', 'B'], { shape: 'or', bubble: true }, (b) => {
  b.add('OR', 160, 0, {}, 'or'); b.add('NOT', 320, 0, {}, 'not'); out(b, 460);
  b.wire('in0', 0, 'or', 0); b.wire('in1', 0, 'or', 1); b.wire('or', 2, 'not', 0); b.wire('not', 1, 'out0', 0);
});
gate('XNOR', 'XNOR', ['A', 'B'], { shape: 'xor', bubble: true }, (b) => {
  b.add('XOR', 160, 0, {}, 'xor'); b.add('NOT', 320, 0, {}, 'not'); out(b, 460);
  b.wire('in0', 0, 'xor', 0); b.wire('in1', 0, 'xor', 1); b.wire('xor', 2, 'not', 0); b.wire('not', 1, 'out0', 0);
});

export const isChip = (type: string) => !!PARTS[type]?.chip;

/**
 * Expand every chip (recursively) into primitives. Inner ids are `${chipId}/${innerId}`. Returns the flat
 * circuit plus, for each chip instance, the flat pin each chip pin maps to (its PORT component).
 */
export function flatten(c: Circuit): { circuit: Circuit; ext: Map<string, PinRef[]> } {
  const components: Circuit['components'] = [], wires: Circuit['wires'] = [];
  const ext = new Map<string, PinRef[]>();
  const expand = (comp: Circuit['components'][number], depth: number) => {
    const chip = PARTS[comp.type]?.chip;
    if (!chip) { components.push(comp); return; }
    if (depth > 32) throw new Error('chip nesting too deep (recursive chip?)');
    const w = width(comp.props), pre = comp.id + '/';
    for (const inner of chip.circuit.components)
      expand({ ...inner, id: pre + inner.id, props: { ...inner.props, ...(PARTS[inner.type]?.hasWidth && w > 1 ? { width: w } : {}) } }, depth + 1);
    for (const iw of chip.circuit.wires)
      wires.push({ id: pre + iw.id, a: { c: pre + iw.a.c, p: iw.a.p }, b: { c: pre + iw.b.c, p: iw.b.p } });
    const nPins = chip.inputs.length + chip.outputs.length;
    ext.set(comp.id, Array.from({ length: nPins }, (_, i) => ({ c: pre + portId(chip, i), p: 0 })));
  };
  for (const comp of c.components) expand(comp, 0);
  const redirect = (r: PinRef) => ext.get(r.c)?.[r.p] ?? r;
  return {
    circuit: { version: 1, components, wires: [...c.wires, ...wires].map((w) => ({ id: w.id, a: redirect(w.a), b: redirect(w.b) })) },
    ext,
  };
}
