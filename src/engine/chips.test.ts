import { describe, expect, it } from 'vitest';
import { Builder } from './build';
import { Sim } from './sim';
import { PARTS } from './parts';
import { Circuit, V0, V1 } from './types';

const TABLES: Record<string, (a: number, b: number) => number> = {
  NAND: (a, b) => 1 - (a & b), AND: (a, b) => a & b, OR: (a, b) => a | b, NOR: (a, b) => 1 - (a | b),
  XOR: (a, b) => a ^ b, XNOR: (a, b) => 1 - (a ^ b),
};
const UNARY: Record<string, (a: number) => number> = { NOT: (a) => 1 - a, BUF: (a) => a };

function rig(type: string, w = 1) {
  const b = new Builder();
  const n = PARTS[type].pins({ width: w }).filter((p) => p.dir === 'in').length;
  const ins = Array.from({ length: n }, () => b.add('IN', 0, 0, { width: w, value: 0 }));
  const g = b.add(type, 0, 0, { width: w }), o = b.add('OUT', 0, 0, { width: w });
  ins.forEach((id, i) => b.wire(id, 0, g, i));
  b.wire(g, n, o, 0);
  const sim = new Sim(b.c);
  const set = (vals: number[]) => { vals.forEach((v, i) => { b.comp(ins[i]).props.value = v; sim.touch(ins[i]); }); expect(sim.settle()).toBe(true); };
  const read = () => sim.pinValue(o, 0).reduce<number>((acc, bit, i) => acc | (bit << i), 0);
  return { b, sim, set, read, g, o };
}

describe('built-in gates (made of NANDs) truth tables', () => {
  for (const [type, f] of Object.entries(TABLES)) it(type, () => {
    const r = rig(type);
    for (const [a, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) { r.set([a, c]); expect(r.read(), `${type}(${a},${c})`).toBe(f(a, c)); }
  });
  for (const [type, f] of Object.entries(UNARY)) it(type, () => {
    const r = rig(type);
    for (const a of [0, 1, 0]) { r.set([a]); expect(r.read()).toBe(f(a)); }
  });
});

describe('gates on buses (bitwise)', () => {
  for (const [type, f] of Object.entries(TABLES)) it(`${type} 8-bit`, () => {
    const r = rig(type, 8);
    for (const [a, c] of [[0b11001010, 0b10101100], [0xff, 0x00], [0x5a, 0x5a]]) {
      r.set([a, c]);
      let want = 0; for (let i = 0; i < 8; i++) want |= f((a >> i) & 1, (c >> i) & 1) << i;
      expect(r.read()).toBe(want);
    }
  });
  it('NOT 4-bit', () => { const r = rig('NOT', 4); r.set([0b0110]); expect(r.read()).toBe(0b1001); });
});

describe('chips are realistic (flattened NANDs keep delays)', () => {
  it('AND output lags input by input delay + 2 NAND delays', () => {
    const r = rig('AND'); r.set([1, 1]);
    r.b.comp(r.b.c.components[0].id).props.value = 0; r.sim.touch(r.b.c.components[0].id);
    for (let i = 0; i < 3; i++) r.sim.tick();
    expect(r.sim.pinValue(r.o, 0)).toEqual([V1]);
    r.sim.tick();
    expect(r.sim.pinValue(r.o, 0)).toEqual([V0]);
  });
  it('NOR (OR + NOT chips) is nested and inner values are readable', () => {
    const r = rig('NOR'); r.set([1, 0]);
    expect(r.sim.pinValue(`${r.g}/or`, 2)).toEqual([V1]);   // inner OR chip output
    expect(r.sim.pinValue(`${r.g}/or/n3`, 2)).toEqual([V1]); // NAND inside the inner OR
    expect(r.read()).toBe(0);
  });
  it('chip pin values are visible on the chip itself', () => {
    const r = rig('XOR'); r.set([1, 0]);
    expect(r.sim.pinValue(r.g, 0)).toEqual([V1]);
    expect(r.sim.pinValue(r.g, 2)).toEqual([V1]);
  });
});

describe('compatibility', () => {
  it('a circuit saved before chips existed still loads and runs', () => {
    const saved: Circuit = JSON.parse(`{"version":1,"components":[
      {"id":"inA","type":"IN","x":0,"y":-40,"rot":0,"props":{"label":"A","value":1}},
      {"id":"inB","type":"IN","x":0,"y":40,"rot":0,"props":{"label":"B","value":1}},
      {"id":"nand1","type":"NAND","x":140,"y":0,"rot":0,"props":{}},
      {"id":"nand2","type":"NAND","x":300,"y":0,"rot":0,"props":{}},
      {"id":"led","type":"OUT","x":440,"y":0,"rot":0,"props":{"label":"A AND B"}}],
      "wires":[{"id":"w1","a":{"c":"inA","p":0},"b":{"c":"nand1","p":0}},{"id":"w2","a":{"c":"inB","p":0},"b":{"c":"nand1","p":1}},
      {"id":"w3","a":{"c":"nand1","p":2},"b":{"c":"nand2","p":0}},{"id":"w4","a":{"c":"nand1","p":2},"b":{"c":"nand2","p":1}},
      {"id":"w5","a":{"c":"nand2","p":2},"b":{"c":"led","p":0}}]}`);
    const sim = new Sim(saved); sim.settle();
    expect(sim.pinValue('led', 0)).toEqual([V1]);
    expect(sim.badWires.size).toBe(0);
  });
  it('unknown part types are skipped, not fatal', () => {
    const sim = new Sim({ version: 1, components: [{ id: 'x', type: 'FUTURE', x: 0, y: 0, rot: 0, props: {} }], wires: [] });
    expect(sim.stable).toBe(true);
  });
});
