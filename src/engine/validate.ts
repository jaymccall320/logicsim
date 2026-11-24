// Defensive loader for circuits coming from IndexedDB or an imported file: never throws, drops what it can't use.
import { PARTS, groupsOf, width } from './parts';
import { Circuit, Component, Props, Wire } from './types';

export interface Sanitized { circuit: Circuit; droppedParts: string[]; droppedWires: number }

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function sanitize(raw: unknown): Sanitized | null {
  const r = raw as { components?: unknown; wires?: unknown } | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.components) || !Array.isArray(r.wires)) return null;
  const components: Component[] = [], droppedParts: string[] = [], ids = new Set<string>();
  for (const x of r.components as Array<Record<string, unknown>>) {
    const type = typeof x?.type === 'string' ? x.type : '?';
    const def = PARTS[type];
    if (!x || typeof x !== 'object' || !def || type === 'PORT') { droppedParts.push(type); continue; }
    let id = typeof x.id === 'string' && x.id ? x.id : 'p' + components.length;
    while (ids.has(id)) id += '_';
    ids.add(id);
    const props: Props = x.props && typeof x.props === 'object' ? { ...(x.props as Props) } : {};
    if (def.hasWidth) props.width = Math.max(1, Math.min(def.maxWidth, Math.round(num(props.width, 1)))); else delete props.width;
    if (props.width === 1) delete props.width;
    if (type === 'IN' || type === 'CONST') {
      const m = 2 ** width(props);
      props.value = ((Math.floor(num(props.value, 0)) % m) + m) % m;
    }
    if (type === 'SPLIT' || type === 'MERGE') { const g = groupsOf(props); if (g.every((n) => n === 1)) delete props.groups; else props.groups = g; }
    else delete props.groups;
    if (props.label !== undefined && typeof props.label !== 'string') delete props.label;
    if (props.delay !== undefined) props.delay = Math.max(1, Math.min(1000, Math.round(num(props.delay, 1))));
    components.push({ id, type, x: num(x.x, 0), y: num(x.y, 0), rot: ((Math.round(num(x.rot, 0)) % 4) + 4) % 4, props });
  }
  const byId = new Map(components.map((c) => [c.id, c]));
  const wires: Wire[] = []; let droppedWires = 0;
  for (const w of r.wires as Array<Record<string, any>>) {
    const ca = byId.get(w?.a?.c), cb = byId.get(w?.b?.c);
    const okPin = (c: Component | undefined, p: unknown) => !!c && Number.isInteger(p) && (p as number) >= 0 && (p as number) < PARTS[c.type].pins(c.props).length;
    if (!okPin(ca, w?.a?.p) || !okPin(cb, w?.b?.p)) { droppedWires++; continue; }
    wires.push({ id: typeof w.id === 'string' && w.id ? w.id : 'w' + wires.length, a: { c: w.a.c, p: w.a.p }, b: { c: w.b.c, p: w.b.p } });
  }
  return { circuit: { version: 1, components, wires }, droppedParts, droppedWires };
}
