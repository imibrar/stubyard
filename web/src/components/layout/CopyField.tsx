import type { ReactNode } from 'react';
import { Icon } from '../people';
import { useCopy } from '../ui';

/**
 * A copyable value (URL, id, code, password). Long values are middle-truncated ("https://localhost:4443/…a1b2/token")
 * so both ends stay readable; the full value is in the tooltip and is what gets copied. Safe inside clickable rows.
 */
export function CopyField({ value, label, display, copied, className = '', middle = true, mono = true }: { value: string; label?: ReactNode; display?: string; copied?: string; className?: string; middle?: boolean; mono?: boolean }) {
  const copy = useCopy();
  const text = display ?? value;
  const tail = middle && text.length > 24 ? text.slice(-Math.min(16, Math.floor(text.length / 3))) : '';
  const head = tail ? text.slice(0, text.length - tail.length) : text;
  return (
    <button
      type="button"
      className={`cred copy-field ${mono ? 'mono' : ''} ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        void copy(value, copied ?? 'Copied');
      }}
      title={`Copy ${value}`}
      aria-label={`Copy ${typeof label === 'string' ? label : value}`}
    >
      {label && <span className="copy-field-label">{label}</span>}
      <span className="copy-field-value">
        <span className="copy-field-head">{head}</span>
        {tail && <span className="copy-field-tail">{tail}</span>}
      </span>
      <Icon name="copy" size={12} />
    </button>
  );
}
