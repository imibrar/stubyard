// Small shared UI pieces of the side panel.
import { useLayoutEffect, useRef, useState } from 'react';

/** Text clamped to `lines` lines with a More / Less toggle (shown only when the text overflows). */
export function Clamp({ text, lines, className = '', dir }: { text: string; lines: number; className?: string; dir?: 'auto' | 'ltr' | 'rtl' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, lines, open]);
  return (
    <div className={className}>
      <div ref={ref} className="clamp" dir={dir} style={open ? undefined : { WebkitLineClamp: lines }}>
        {text}
      </div>
      {(overflows || open) && (
        <button className="link small" onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
