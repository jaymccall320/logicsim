import { PARTS, PartDef } from './parts';
import { flatten } from './chips';
import { Bit, Circuit, Component, PinRef, V0, VX, VZ } from './types';

/**
 * Event-driven, bit-level simulator with per-component propagation delay (transport delay, in ticks).
 *
 * Compilation: every bit of every pin gets a provisional node; wires (same width) and pure wiring parts
 * (splitter/merger) union those nodes bit-by-bit. Each resulting node is one electrical bit.
 * Nodes are driven by output "slots" (one per output bit). A node's value is the resolution of its drivers:
 * none / all floating -> Z, agreeing -> that value, disagreeing (or any X) -> X (conflict).
 *
 * Time: events (slot := value) are queued at absolute ticks. tick() applies the events for the current tick,
 * resolves the affected nodes, re-evaluates components that read a changed node and schedules their new outputs
 * at now + delay. Oscillating circuits never settle, so callers run a bounded number of ticks per frame.
 *
 * Future "chip" parts plug in as another PartDef: a realistic chip is flattened into primitives before compile,
 * a fast chip gets an eval() backed by a compiled truth table / function.
 */
export class Sim {
  readonly comps: Component[];
  private defs: PartDef[];
  nodeCount = 0;
  nodeVal!: Uint8Array;
  /** compIndex -> pinIndex -> bit -> node */
  pinNodes: number[][][] = [];
  private slotVal!: Uint8Array;  // current driven value
  private slotLast!: Uint8Array; // last value scheduled (avoid duplicate events)
  private slotNode!: Int32Array;
  private compOutSlots: number[][][] = []; // compIndex -> outPinIndex -> bit -> slot
  private compInPins: number[][] = [];     // compIndex -> pin indices that are inputs
  private compOutPins: number[][] = [];
  private nodeDrivers: number[][] = [];
  private nodeReaders: number[][] = [];
  private compIndex = new Map<string, number>();
  private queue = new Map<number, number[]>(); // tick -> flat [slot, value, slot, value, ...]
  private dirty = new Set<number>();          // components needing evaluation this tick
  time = 0;
  evals = 0;
  /** Wires that could not be connected (width mismatch / dangling). */
  badWires = new Set<string>();

  /** chip instance id -> chip pin -> flat pin (PORT inside the chip) */
  private ext = new Map<string, PinRef[]>();

  constructor(source: Circuit, prev?: Sim) {
    const flat = flatten({ ...source, components: source.components.filter((c) => PARTS[c.type]) });
    const circuit = flat.circuit;
    this.ext = flat.ext;
    this.comps = circuit.components;
    this.defs = this.comps.map((c) => PARTS[c.type]);
    this.compile(circuit, prev);
  }

  private compile(circuit: Circuit, prev?: Sim) {
    // 1. provisional nodes for every pin bit
    let n = 0;
    const pinsPer = this.comps.map((c, ci) => {
      this.compIndex.set(c.id, ci);
      return this.defs[ci].pins(c.props);
    });
    this.pinNodes = pinsPer.map((pins) => pins.map((p) => Array.from({ length: p.width }, () => n++)));
    const parent = new Int32Array(n).map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

    // 2. wires
    for (const w of circuit.wires) {
      const ca = this.compIndex.get(w.a.c), cb = this.compIndex.get(w.b.c);
      const pa = ca === undefined ? undefined : this.pinNodes[ca][w.a.p];
      const pb = cb === undefined ? undefined : this.pinNodes[cb][w.b.p];
      if (!pa || !pb || pa.length !== pb.length) { this.badWires.add(w.id); continue; }
      for (let i = 0; i < pa.length; i++) union(pa[i], pb[i]);
    }
    // 3. wiring parts
    this.comps.forEach((c, ci) => {
      const al = this.defs[ci].alias?.(c.props);
      if (al) for (const [pa, ba, pb, bb] of al) union(this.pinNodes[ci][pa][ba], this.pinNodes[ci][pb][bb]);
    });
    // 4. compact node ids
    const remap = new Int32Array(n).fill(-1);
    let nodes = 0;
    for (let i = 0; i < n; i++) { const r = find(i); if (remap[r] < 0) remap[r] = nodes++; }
    this.pinNodes = this.pinNodes.map((pins) => pins.map((bits) => bits.map((b) => remap[find(b)])));
    this.nodeCount = nodes;
    this.nodeVal = new Uint8Array(nodes).fill(VZ);
    this.nodeDrivers = Array.from({ length: nodes }, () => []);
    this.nodeReaders = Array.from({ length: nodes }, () => []);

    // 5. driver slots / readers
    const slotNode: number[] = [], slotInit: number[] = [];
    this.comps.forEach((c, ci) => {
      const def = this.defs[ci];
      const ins: number[] = [], outs: number[] = [];
      this.compOutSlots[ci] = [];
      if (!def.eval) { // pure sink or pure wiring part
        pinsPer[ci].forEach((_, pi) => ins.push(pi));
        this.compInPins[ci] = def.alias ? [] : ins; this.compOutPins[ci] = [];
        return;
      }
      const prevCi = prev?.compIndex.get(c.id);
      pinsPer[ci].forEach((p, pi) => {
        if (p.dir === 'in') {
          ins.push(pi);
          for (const node of this.pinNodes[ci][pi]) if (!this.nodeReaders[node].includes(ci)) this.nodeReaders[node].push(ci);
        } else {
          const outIdx = outs.length; outs.push(pi);
          const slots = this.pinNodes[ci][pi].map((node, bit) => {
            const s = slotNode.length;
            slotNode.push(node);
            this.nodeDrivers[node].push(s);
            let init = c.type === 'TRI' ? VZ : V0;
            if (prev && prevCi !== undefined) {
              const ps = prev.compOutSlots[prevCi]?.[outIdx]?.[bit];
              if (ps !== undefined) init = prev.slotVal[ps];
            }
            slotInit.push(init);
            return s;
          });
          this.compOutSlots[ci].push(slots);
        }
      });
      this.compInPins[ci] = ins; this.compOutPins[ci] = outs;
      this.dirty.add(ci);
    });
    this.slotNode = Int32Array.from(slotNode);
    this.slotVal = Uint8Array.from(slotInit);
    this.slotLast = Uint8Array.from(slotInit);
    for (let i = 0; i < nodes; i++) this.nodeVal[i] = this.resolve(i);
    if (prev) this.time = prev.time;
  }

  private resolve(node: number): Bit {
    let r: number = VZ;
    for (const s of this.nodeDrivers[node]) {
      const v = this.slotVal[s];
      if (v === VZ) continue;
      if (r === VZ) r = v; else if (r !== v || v === VX) { r = VX; break; }
    }
    return r as Bit;
  }

  /** True when two or more enabled drivers disagree on this node. */
  isConflict(node: number): boolean {
    let seen = -1;
    for (const s of this.nodeDrivers[node]) {
      const v = this.slotVal[s];
      if (v === VZ) continue;
      if (seen >= 0 && v !== seen) return true;
      seen = v;
    }
    return false;
  }

  private schedule(at: number, slot: number, v: number) {
    let b = this.queue.get(at);
    if (!b) this.queue.set(at, (b = []));
    b.push(slot, v);
  }

  get stable() { return this.queue.size === 0 && this.dirty.size === 0; }

  /** Mark a component (e.g. an input pin whose value changed) for re-evaluation on the next tick. */
  touch(id: string) { const ci = this.compIndex.get(id); if (ci !== undefined) this.dirty.add(ci); }

  /** Advance one tick. */
  tick() {
    const ev = this.queue.get(this.time);
    if (ev) {
      this.queue.delete(this.time);
      const changedNodes = new Set<number>();
      for (let i = 0; i < ev.length; i += 2) {
        if (this.slotVal[ev[i]] !== ev[i + 1]) { this.slotVal[ev[i]] = ev[i + 1]; changedNodes.add(this.slotNode[ev[i]]); }
      }
      for (const node of changedNodes) {
        const v = this.resolve(node);
        if (v !== this.nodeVal[node]) {
          this.nodeVal[node] = v;
          for (const ci of this.nodeReaders[node]) this.dirty.add(ci);
        }
      }
    }
    if (this.dirty.size) {
      const list = [...this.dirty];
      this.dirty.clear();
      for (const ci of list) this.evaluate(ci);
    }
    this.time++;
  }

  private evaluate(ci: number) {
    this.evals++;
    const def = this.defs[ci], comp = this.comps[ci];
    const ins = this.compInPins[ci].map((pi) => this.pinNodes[ci][pi].map((n) => this.nodeVal[n] as Bit));
    const outs = this.compOutSlots[ci].map((slots) => new Array<Bit>(slots.length).fill(VZ));
    def.eval!(ins, outs, comp);
    const delay = Math.max(1, comp.props.delay ?? def.delay);
    this.compOutSlots[ci].forEach((slots, oi) => slots.forEach((s, bit) => {
      const v = outs[oi][bit];
      if (v !== this.slotLast[s]) { this.slotLast[s] = v; this.schedule(this.time + delay, s, v); }
    }));
  }

  /** Run up to maxTicks ticks, stopping early when stable or when the evaluation budget is spent. */
  run(maxTicks: number, maxEvals = 200_000): number {
    const start = this.evals;
    let t = 0;
    while (t < maxTicks && !this.stable && this.evals - start < maxEvals) { this.tick(); t++; }
    return t;
  }

  /** Run until stable (or limit). Returns true if it settled. */
  settle(limit = 10_000): boolean { this.run(limit, Infinity); return this.stable; }

  // ---- inspection helpers ----
  pinValue(compId: string, pin: number): Bit[] {
    const e = this.ext.get(compId)?.[pin];
    if (e) return this.pinValue(e.c, e.p);
    const ci = this.compIndex.get(compId);
    if (ci === undefined) return [];
    return (this.pinNodes[ci][pin] ?? []).map((n) => this.nodeVal[n] as Bit);
  }
  pinNodesOf(compId: string, pin: number): number[] {
    const e = this.ext.get(compId)?.[pin];
    if (e) return this.pinNodesOf(e.c, e.p);
    const ci = this.compIndex.get(compId);
    return ci === undefined ? [] : this.pinNodes[ci][pin] ?? [];
  }
}
