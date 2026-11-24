import { describe, expect, it } from 'vitest';
import { Builder } from './build';
import { PARTS, groupsOf } from './parts';
import { Sim } from './sim';
import { sanitize } from './validate';
import { Bit, V0, V1, VZ } from './types';

const num = (bits: Bit[]) => bits.reduce<number>((a, b, i) => a + (b === V1 ? 2 ** i : 0), 0);
const set = (b: Builder, sim: Sim, id: string, v: number) => { b.comp(id).props.value = v; sim.touch(id); };

describe('splitter / merger groups', () => {
  it('default (no groups) is the old all-1-bit layout', () => {
    expect(groupsOf({ width: 4 })).toEqual([1, 1, 1, 1]);
    expect(PARTS.SPLIT.pins({ width: 4 }).map((p) => p.width)).toEqual([4, 1, 1, 1, 1]);
    expect(PARTS.MERGE.pins({ width: 4 }).map((p) => p.width)).toEqual([1, 1, 1, 1, 4]);
  });
  it('bad group lists fall back to all-1', () => {
    expect(groupsOf({ width: 8, groups: [4, 3] })).toEqual(Array(8).fill(1));
    expect(groupsOf({ width: 8, groups: [4, 0, 4] })).toEqual(Array(8).fill(1));
  });
  it('8 -> 4+4: low nibble on pin 1, high nibble on pin 2', () => {
    const b = new Builder();
    const i = b.add('IN', 0, 0, { width: 8, value: 0xa5 }), sp = b.add('SPLIT', 0, 0, { width: 8, groups: [4, 4] });
    const lo = b.add('OUT', 0, 0, { width: 4 }), hi = b.add('OUT', 0, 0, { width: 4 });
    b.wire(i, 0, sp, 0); b.wire(sp, 1, lo, 0); b.wire(sp, 2, hi, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(sim.badWires.size).toBe(0);
    expect(num(sim.pinValue(lo, 0))).toBe(0x5); expect(num(sim.pinValue(hi, 0))).toBe(0xa);
  });
  it('4+4 -> 8 merger round-trips with the splitter', () => {
    const b = new Builder();
    const i = b.add('IN', 0, 0, { width: 8, value: 0x3c }), sp = b.add('SPLIT', 0, 0, { width: 8, groups: [4, 4] });
    const mg = b.add('MERGE', 0, 0, { width: 8, groups: [4, 4] }), o = b.add('OUT', 0, 0, { width: 8 });
    b.wire(i, 0, sp, 0); b.wire(sp, 1, mg, 0); b.wire(sp, 2, mg, 1); b.wire(mg, 2, o, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(num(sim.pinValue(o, 0))).toBe(0x3c);
  });
  it('swapped nibbles through a merger', () => {
    const b = new Builder();
    const i = b.add('IN', 0, 0, { width: 8, value: 0x1f }), sp = b.add('SPLIT', 0, 0, { width: 8, groups: [4, 4] });
    const mg = b.add('MERGE', 0, 0, { width: 8, groups: [4, 4] }), o = b.add('OUT', 0, 0, { width: 8 });
    b.wire(i, 0, sp, 0); b.wire(sp, 1, mg, 1); b.wire(sp, 2, mg, 0); b.wire(mg, 2, o, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(num(sim.pinValue(o, 0))).toBe(0xf1);
  });
  it('8 -> 8x1 and 8x1 -> 8 (bit-reverse)', () => {
    const b = new Builder();
    const i = b.add('IN', 0, 0, { width: 8, value: 0b00010110 }), sp = b.add('SPLIT', 0, 0, { width: 8 });
    const mg = b.add('MERGE', 0, 0, { width: 8 }), o = b.add('OUT', 0, 0, { width: 8 });
    b.wire(i, 0, sp, 0); for (let k = 0; k < 8; k++) b.wire(sp, 1 + k, mg, 7 - k); b.wire(mg, 8, o, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(num(sim.pinValue(o, 0))).toBe(0b01101000);
  });
  it('16 -> 8+8 and uneven 1+7', () => {
    const b = new Builder();
    const i = b.add('IN', 0, 0, { width: 16, value: 0xbeef }), sp = b.add('SPLIT', 0, 0, { width: 16, groups: [8, 8] });
    const lo = b.add('OUT', 0, 0, { width: 8 }), hi = b.add('OUT', 0, 0, { width: 8 });
    b.wire(i, 0, sp, 0); b.wire(sp, 1, lo, 0); b.wire(sp, 2, hi, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(num(sim.pinValue(lo, 0))).toBe(0xef); expect(num(sim.pinValue(hi, 0))).toBe(0xbe);
    const b2 = new Builder();
    const j = b2.add('IN', 0, 0, { width: 8, value: 0b10110011 }), s2 = b2.add('SPLIT', 0, 0, { width: 8, groups: [1, 7] });
    const bit0 = b2.add('OUT'), rest = b2.add('OUT', 0, 0, { width: 7 });
    b2.wire(j, 0, s2, 0); b2.wire(s2, 1, bit0, 0); b2.wire(s2, 2, rest, 0);
    const sim2 = new Sim(b2.c); sim2.settle();
    expect(sim2.pinValue(bit0, 0)).toEqual([V1]); expect(num(sim2.pinValue(rest, 0))).toBe(0b1011001);
  });
  it('width mismatch against a group pin is rejected', () => {
    const b = new Builder();
    const sp = b.add('SPLIT', 0, 0, { width: 8, groups: [4, 4] }), o = b.add('OUT', 0, 0, { width: 8 });
    b.wire(sp, 1, o, 0);
    expect(new Sim(b.c).badWires.size).toBe(1);
  });
  it('tri-state bus passes through a splitter group', () => {
    const b = new Builder();
    const d = b.add('IN', 0, 0, { width: 4, value: 9 }), en = b.add('IN'), t = b.add('TRI', 0, 0, { width: 4 });
    const mg = b.add('MERGE', 0, 0, { width: 8, groups: [4, 4] }), o = b.add('OUT', 0, 0, { width: 8 });
    b.wire(d, 0, t, 0); b.wire(en, 0, t, 1); b.wire(t, 2, mg, 0); b.wire(mg, 2, o, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(sim.pinValue(o, 0).slice(0, 4)).toEqual([VZ, VZ, VZ, VZ]);
    set(b, sim, en, 1); sim.settle();
    expect(num(sim.pinValue(o, 0).slice(0, 4))).toBe(9);
  });
});

describe('constants and displays', () => {
  it('CONST 1 and 0 drive a wire; CONST bus value', () => {
    const b = new Builder();
    const hi = b.add('CONST', 0, 0, { value: 1 }), lo = b.add('CONST', 0, 0, { value: 0 }), k = b.add('CONST', 0, 0, { width: 8, value: 0xa7 });
    const g = b.add('NAND'), o = b.add('OUT'), ko = b.add('OUT', 0, 0, { width: 8 });
    b.wire(hi, 0, g, 0); b.wire(lo, 0, g, 1); b.wire(g, 2, o, 0); b.wire(k, 0, ko, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(sim.pinValue(o, 0)).toEqual([V1]); expect(sim.pinValue(lo, 0)).toEqual([V0]); expect(num(sim.pinValue(ko, 0))).toBe(0xa7);
  });
  it('HEX display and 7-segment sink bus / segment signals', () => {
    const b = new Builder();
    const i = b.add('IN', 0, 0, { width: 8, value: 0x5c }), h = b.add('HEX', 0, 0, { width: 8 });
    const s = b.add('IN', 0, 0, { value: 1 }), seg = b.add('SEG7');
    b.wire(i, 0, h, 0); b.wire(s, 0, seg, 3);
    const sim = new Sim(b.c); sim.settle();
    expect(num(sim.pinValue(h, 0))).toBe(0x5c); expect(sim.pinValue(seg, 3)).toEqual([V1]); expect(sim.pinValue(seg, 0)).toEqual([VZ]);
    expect(PARTS.SEG7.pins({}).length).toBe(7);
  });
  it('32-bit values survive (no 31-bit overflow)', () => {
    const b = new Builder();
    const i = b.add('IN', 0, 0, { width: 32, value: 0xdeadbeef }), o = b.add('OUT', 0, 0, { width: 32 });
    b.wire(i, 0, o, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(num(sim.pinValue(o, 0))).toBe(0xdeadbeef);
  });
});

describe('sanitize (import / autosave loader)', () => {
  it('rejects non-circuits', () => { expect(sanitize(null)).toBeNull(); expect(sanitize({ components: 1, wires: [] })).toBeNull(); });
  it('drops unknown parts, bad pins, clamps widths and rotation', () => {
    const r = sanitize({ components: [
      { id: 'z', type: 'FUTURE', x: 1, y: 1, rot: 0, props: {} },
      { id: 'n', type: 'NAND' },
      { id: 'q', type: 'IN', x: 'a', y: 5, rot: 9, props: { width: 999, value: -3 } },
      { id: 'n', type: 'OUT', props: { width: 8, groups: [1, 2] } },
      { id: 's', type: 'SPLIT', props: { width: 8, groups: [4, 4] } }],
    wires: [{ id: 'w', a: { c: 'n', p: 0 }, b: { c: 'z', p: 0 } }, { id: 'w2', a: { c: 'n', p: 77 }, b: { c: 'q', p: 0 } }, { id: 'w3', a: { c: 'n', p: 2 }, b: { c: 'q', p: 0 } }] })!;
    expect(r.droppedParts).toEqual(['FUTURE']); expect(r.droppedWires).toBe(2);
    expect(r.circuit.components.map((c) => c.id)).toEqual(['n', 'q', 'n_', 's']);
    const q = r.circuit.components[1]; expect(q.props.width).toBe(32); expect(q.rot).toBe(1); expect(q.x).toBe(0); expect(q.props.value).toBe(2 ** 32 - 3);
    expect(r.circuit.components[3].props.groups).toEqual([4, 4]);
    expect(() => new Sim(r.circuit)).not.toThrow();
  });
  it('old saves (4-wide splitter, no groups) load unchanged', () => {
    const r = sanitize({ components: [{ id: 's', type: 'SPLIT', x: 0, y: 0, rot: 0, props: { width: 4 } }], wires: [] })!;
    expect(r.circuit.components[0].props).toEqual({ width: 4 });
    expect(PARTS.SPLIT.pins(r.circuit.components[0].props).length).toBe(5);
  });
});
