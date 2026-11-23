import type { ReactNode } from 'react';

export interface KV {
  label: ReactNode;
  value: ReactNode;
  key?: string;
}

/** Definition list of facts (uses the .kv grid). `wide` gives labels more room; `bare` drops the frame. */
export function KeyValue({ items, wide, bare, className = '' }: { items: KV[]; wide?: boolean; bare?: boolean; className?: string }) {
  return (
    <dl className={`kv ${wide ? 'wide' : ''} ${bare ? 'bare' : ''} ${className}`}>
      {items.map((it, i) => (
        <div key={it.key ?? i} className="kv-row">
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
