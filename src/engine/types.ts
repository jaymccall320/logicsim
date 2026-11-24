// Signal values for a single bit.
export const V0 = 0, V1 = 1, VZ = 2, VX = 3; // VZ = floating, VX = conflict / unknown
export type Bit = 0 | 1 | 2 | 3;

export interface Props {
  width?: number;   // bus width in bits (1 = single wire)
  value?: number;   // current value of an input pin (bit field)
  label?: string;
  delay?: number;   // propagation delay in ticks (default per part)
}

export interface Component {
  id: string;
  type: string;
  x: number; // centre, world units
  y: number;
  rot: number; // 0..3 quarter turns clockwise
  props: Props;
}

export interface PinRef { c: string; p: number }
export interface Wire { id: string; a: PinRef; b: PinRef }

export interface Circuit {
  version: 1;
  components: Component[];
  wires: Wire[];
}

export function bitChar(b: Bit): string {
  return b === V0 ? '0' : b === V1 ? '1' : b === VZ ? 'Z' : 'X';
}
