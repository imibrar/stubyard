import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Channel } from '../api';
import { useFocusTrap } from './layout/hooks';

// ---------- toast ----------
const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 1800);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={setMsg}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}

export function useCopy() {
  const toast = useToast();
  return useCallback(
    async (text: string, label = 'Copied') => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(label);
    },
    [toast],
  );
}

// ---------- icons ----------
export function ChannelIcon({ channel, size = 16 }: { channel: Channel; size?: number }) {
  const color = `var(--${channel})`;
  if (channel === 'email') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" aria-label="Email">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </svg>
    );
  }
  if (channel === 'sms') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" aria-label="SMS">
        <path d="M4 5h16v11H9l-5 4z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" aria-label="WhatsApp">
      <path d="M20 12a8 8 0 0 1-11.8 7L4 20l1.1-4A8 8 0 1 1 20 12z" />
    </svg>
  );
}

export const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

// ---------- primitives ----------
export function Badge({ kind, children, title }: { kind?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${kind ?? ''}`} title={title}>
      {children}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
    </div>
  );
}

/** A rough label for untitled snippets, shown in the code block's header bar. */
function guessLang(code: string): string {
  const t = code.trimStart();
  if (/^[[{]/.test(t)) return 'json';
  if (/^<[a-z!?]/i.test(t)) return 'markup';
  if (/^(curl|sudo|export|npm|npx|docker|cd|set|\$) /.test(t)) return 'shell';
  return 'text';
}

/**
 * Code with a header bar (title or language + Copy) so the button never covers the code.
 * Long lines wrap by default; "Wrap" switches to scrolling inside the block (no page-level scroll).
 */
export function CodeBlock({ code, title, lang, wrap: wrapDefault = true }: { code: string; title?: string; lang?: string; wrap?: boolean }) {
  const copy = useCopy();
  const [wrap, setWrap] = useState(wrapDefault);
  return (
    <div className={`code ${wrap ? 'wrap' : 'nowrap'}`}>
      <div className="code-head">
        <span className={title ? 'code-title' : 'code-lang'} title={title}>
          {title ?? lang ?? guessLang(code)}
        </span>
        <button className="btn xs ghost code-wrap" onClick={() => setWrap(!wrap)} aria-pressed={wrap} title={wrap ? 'Long lines wrap (click to scroll instead)' : 'Long lines scroll (click to wrap)'}>
          {wrap ? 'Wrap' : 'No wrap'}
        </button>
        <button className="btn xs copy" onClick={() => copy(code)}>
          Copy
        </button>
      </div>
      <pre tabIndex={wrap ? undefined : 0}>{code}</pre>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const headId = useId();
  useFocusTrap(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={headId}>
        <div className="modal-head">
          <h2 id={headId}>{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const headId = useId();
  useFocusTrap(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-labelledby={headId}>
        <div className="drawer-head">
          <div className="grow" id={headId}>
            {title}
          </div>
          {actions}
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** The same head/body as Drawer, docked beside a list instead of over the page (no backdrop, no focus trap). */
export function DockPanel({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const headId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="drawer dock-panel" role="region" aria-labelledby={headId}>
      <div className="drawer-head">
        <div className="grow" id={headId}>
          {title}
        </div>
        {actions}
        <button className="btn sm ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? <div className="error-box">{error}</div> : null;
}

// ---------- formatting ----------
export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Date and time, e.g. "Nov 20, 2026, 01:33:09 PM" (for values that can be days away, like an expiry). */
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "in 23h" / "in 5m" for a future time, "" once it has passed. */
export function timeUntil(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return '';
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string): string {
  return name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export const OUTCOME_KIND: Record<string, string> = {
  ok: 'ok',
  pending: '',
  unmatched: 'warn',
  invalid: 'warn',
  rejected: 'warn',
  forced_error: 'accent',
  internal_error: 'bad',
  network_error: 'bad',
};

/** Re-render every `ms` so relative times stay fresh. */
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
