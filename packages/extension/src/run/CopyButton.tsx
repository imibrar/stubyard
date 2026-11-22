// A copy button with the clipboard fallback chain of the spike (docs/design/floating-widget.md): the async clipboard,
// then execCommand('copy') (copyText), then, when both are blocked (a page Permissions-Policy, no focus), the text in a
// selected read-only field with "Select the text and copy it".
import { useEffect, useRef, useState } from 'react';
import { copyText } from './clipboard';

export function CopyButton({ text, what, label = 'copy' }: { text: string; what: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state === 'copied') {
      const id = setTimeout(() => setState('idle'), 1500);
      return () => clearTimeout(id);
    }
    if (state === 'manual') field.current?.select();
  }, [state]);
  if (state === 'manual') {
    return (
      <span className="copy-manual">
        <input ref={field} readOnly value={text} aria-label={`${what}: select the text and copy it`} onFocus={(e) => e.currentTarget.select()} />
        <span className="muted small">Select the text and copy it (Ctrl+C).</span>{' '}
        <button className="link small" onClick={() => setState('idle')}>
          done
        </button>
      </span>
    );
  }
  return (
    <button className="link" aria-label={`Copy the ${what}`} title={`Copy the ${what}`} onClick={() => void copyText(text).then((ok) => setState(ok ? 'copied' : 'manual'))}>
      {state === 'copied' ? 'copied' : label}
    </button>
  );
}
