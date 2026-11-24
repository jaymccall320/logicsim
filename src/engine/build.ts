// Tiny helper for building circuits in code (tests, sample circuits).
import { Circuit, Component, Props } from './types';
export class Builder {
  c: Circuit = { version: 1, components: [], wires: [] };
  private n = 0;
  add(type: string, x = 0, y = 0, props: Props = {}, id?: string): string {
    const comp: Component = { id: id ?? `${type.toLowerCase()}${++this.n}`, type, x, y, rot: 0, props };
    this.c.components.push(comp);
    return comp.id;
  }
  wire(a: string, ap: number, b: string, bp: number) {
    this.c.wires.push({ id: `w${this.c.wires.length + 1}`, a: { c: a, p: ap }, b: { c: b, p: bp } });
  }
  comp(id: string) { return this.c.components.find((c) => c.id === id)!; }
}
