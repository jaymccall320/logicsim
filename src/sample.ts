import { Builder } from './engine/build';
import { Circuit } from './engine/types';
/** Starter circuit: AND built from two NANDs. */
export function sampleCircuit(): Circuit {
  const b = new Builder();
  const a = b.add('IN', 0, -40, { label: 'A', value: 1 }, 'inA');
  const c = b.add('IN', 0, 40, { label: 'B', value: 1 }, 'inB');
  const n1 = b.add('NAND', 140, 0, {}, 'nand1');
  const n2 = b.add('NAND', 300, 0, {}, 'nand2');
  const o = b.add('OUT', 440, 0, { label: 'A AND B' }, 'led');
  b.wire(a, 0, n1, 0); b.wire(c, 0, n1, 1); b.wire(n1, 2, n2, 0); b.wire(n1, 2, n2, 1); b.wire(n2, 2, o, 0);
  return b.c;
}
