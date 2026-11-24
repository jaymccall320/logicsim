import { describe, expect, it } from 'vitest';
import { Builder } from './build';
import { Sim } from './sim';
import { V0, V1, VX, VZ } from './types';

const set = (b: Builder, sim: Sim, id: string, v: number) => { b.comp(id).props.value = v; sim.touch(id); };

describe('NAND-built gates', () => {
  it('NOT from one NAND', () => {
    const b = new Builder();
    const a = b.add('IN'), g = b.add('NAND'), o = b.add('OUT');
    b.wire(a, 0, g, 0); b.wire(a, 0, g, 1); b.wire(g, 2, o, 0);
    const sim = new Sim(b.c);
    expect(sim.settle()).toBe(true);
    expect(sim.pinValue(o, 0)).toEqual([V1]);
    set(b, sim, a, 1); sim.settle();
    expect(sim.pinValue(o, 0)).toEqual([V0]);
  });

  it('AND from two NANDs (full truth table) with 2-tick delay', () => {
    const b = new Builder();
    const a = b.add('IN'), c = b.add('IN'), n1 = b.add('NAND'), n2 = b.add('NAND'), o = b.add('OUT');
    b.wire(a, 0, n1, 0); b.wire(c, 0, n1, 1); b.wire(n1, 2, n2, 0); b.wire(n1, 2, n2, 1); b.wire(n2, 2, o, 0);
    const sim = new Sim(b.c);
    for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      set(b, sim, a, x); set(b, sim, c, y);
      expect(sim.settle()).toBe(true);
      expect(sim.pinValue(o, 0)).toEqual([x & y ? V1 : V0]);
    }
    // timing: from 1,1 drop A to 0 -> output must take 3 ticks (input + two gate delays)
    set(b, sim, a, 0);
    sim.tick(); sim.tick(); sim.tick();
    expect(sim.pinValue(o, 0)).toEqual([V1]);
    sim.tick();
    expect(sim.pinValue(o, 0)).toEqual([V0]);
  });

  it('bitwise 8-bit NAND on buses', () => {
    const b = new Builder();
    const a = b.add('IN', 0, 0, { width: 8, value: 0b11001010 }), c = b.add('IN', 0, 0, { width: 8, value: 0b10101010 });
    const g = b.add('NAND', 0, 0, { width: 8 }), o = b.add('OUT', 0, 0, { width: 8 });
    b.wire(a, 0, g, 0); b.wire(c, 0, g, 1); b.wire(g, 2, o, 0);
    const sim = new Sim(b.c); sim.settle();
    const v = sim.pinValue(o, 0).reduce<number>((acc, bit, i) => acc | (bit << i), 0);
    expect(v).toBe(~(0b11001010 & 0b10101010) & 0xff);
  });
});

describe('sequential behaviour', () => {
  it('SR latch from two NANDs (active-low S/R) holds state', () => {
    const b = new Builder();
    const s = b.add('IN', 0, 0, { value: 1 }), r = b.add('IN', 0, 0, { value: 1 });
    const g1 = b.add('NAND'), g2 = b.add('NAND'), q = b.add('OUT'), nq = b.add('OUT');
    b.wire(s, 0, g1, 0); b.wire(g2, 2, g1, 1); b.wire(r, 0, g2, 1); b.wire(g1, 2, g2, 0);
    b.wire(g1, 2, q, 0); b.wire(g2, 2, nq, 0);
    const sim = new Sim(b.c);
    sim.run(100);
    // set
    set(b, sim, s, 0); expect(sim.settle()).toBe(true);
    expect(sim.pinValue(q, 0)).toEqual([V1]); expect(sim.pinValue(nq, 0)).toEqual([V0]);
    set(b, sim, s, 1); expect(sim.settle()).toBe(true);
    expect(sim.pinValue(q, 0)).toEqual([V1]); // holds
    // reset
    set(b, sim, r, 0); sim.settle(); set(b, sim, r, 1); sim.settle();
    expect(sim.pinValue(q, 0)).toEqual([V0]); expect(sim.pinValue(nq, 0)).toEqual([V1]);
  });

  it('3-NAND ring oscillator oscillates and run() stays bounded', () => {
    const b = new Builder();
    const g = [b.add('NAND'), b.add('NAND'), b.add('NAND')];
    for (let i = 0; i < 3; i++) { const nx = g[(i + 1) % 3]; b.wire(g[i], 2, nx, 0); b.wire(g[i], 2, nx, 1); }
    const sim = new Sim(b.c);
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) { sim.tick(); seen.add(sim.pinValue(g[0], 2)[0]); }
    expect(seen.has(V0) && seen.has(V1)).toBe(true);
    expect(sim.stable).toBe(false);
    expect(sim.settle(1000)).toBe(false); // never settles, but returns
    expect(sim.run(1e9, 5000)).toBeLessThan(1e9); // eval budget caps work
  });
});

describe('tri-state and buses', () => {
  const busRig = () => {
    const b = new Builder();
    const d1 = b.add('IN', 0, 0, { value: 1 }), e1 = b.add('IN'), t1 = b.add('TRI');
    const d2 = b.add('IN', 0, 0, { value: 0 }), e2 = b.add('IN'), t2 = b.add('TRI');
    const o = b.add('OUT');
    b.wire(d1, 0, t1, 0); b.wire(e1, 0, t1, 1); b.wire(t1, 2, o, 0);
    b.wire(d2, 0, t2, 0); b.wire(e2, 0, t2, 1); b.wire(t2, 2, o, 0);
    return { b, e1, e2, o, sim: new Sim(b.c) };
  };
  it('floating when nobody drives, value when one drives', () => {
    const { b, e1, e2, o, sim } = busRig();
    sim.settle(); expect(sim.pinValue(o, 0)).toEqual([VZ]);
    set(b, sim, e1, 1); sim.settle(); expect(sim.pinValue(o, 0)).toEqual([V1]);
    set(b, sim, e1, 0); set(b, sim, e2, 1); sim.settle(); expect(sim.pinValue(o, 0)).toEqual([V0]);
  });
  it('conflict when two enabled drivers disagree', () => {
    const { b, e1, e2, o, sim } = busRig();
    set(b, sim, e1, 1); set(b, sim, e2, 1); sim.settle();
    expect(sim.pinValue(o, 0)).toEqual([VX]);
    expect(sim.isConflict(sim.pinNodesOf(o, 0)[0])).toBe(true);
  });
  it('splitter / merger alias bits', () => {
    const b = new Builder();
    const a = b.add('IN', 0, 0, { width: 4, value: 0b0011 }), sp = b.add('SPLIT', 0, 0, { width: 4 });
    const m = b.add('MERGE', 0, 0, { width: 4 }), o = b.add('OUT', 0, 0, { width: 4 });
    b.wire(a, 0, sp, 0);
    // reverse bit order through the wiring
    for (let i = 0; i < 4; i++) b.wire(sp, 1 + i, m, 3 - i);
    b.wire(m, 4, o, 0);
    const sim = new Sim(b.c); sim.settle();
    expect(sim.pinValue(o, 0)).toEqual([V0, V0, V1, V1]); // 0b0011 reversed = 0b1100 (LSB first)
  });
  it('width mismatch wire is rejected', () => {
    const b = new Builder();
    const a = b.add('IN', 0, 0, { width: 4 }), o = b.add('OUT');
    b.wire(a, 0, o, 0);
    const sim = new Sim(b.c);
    expect(sim.badWires.size).toBe(1);
  });
  it('recompile keeps sequential state', () => {
    const b = new Builder();
    const s = b.add('IN', 0, 0, { value: 1 }), r = b.add('IN', 0, 0, { value: 1 });
    const g1 = b.add('NAND'), g2 = b.add('NAND');
    b.wire(s, 0, g1, 0); b.wire(g2, 2, g1, 1); b.wire(r, 0, g2, 1); b.wire(g1, 2, g2, 0);
    let sim = new Sim(b.c); sim.run(50);
    set(b, sim, s, 0); sim.settle(); set(b, sim, s, 1); sim.settle();
    b.add('OUT'); // an unrelated edit triggers recompile
    sim = new Sim(b.c, sim); sim.settle();
    expect(sim.pinValue(g1, 2)).toEqual([V1]);
  });
});
