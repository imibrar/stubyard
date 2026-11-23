import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TestUser } from '../api';
import { initials } from './ui';

// ---------- roles ----------
const FIXED: Record<string, string> = {
  admin: '#f59e0b',
  'super-admin': '#ef4444',
  sales: '#22c55e',
  support: '#06b6d4',
  customer: '#7c83ff',
  user: '#7c83ff',
  manager: '#ec4899',
  driver: '#f97316',
  merchant: '#14b8a6',
  vendor: '#14b8a6',
};
const PALETTE = ['#a78bfa', '#38bdf8', '#f472b6', '#facc15', '#34d399', '#fb923c', '#60a5fa', '#e879f9'];

/** Stable colour per role name. */
export function roleColor(role: string): string {
  const r = role.toLowerCase();
  if (FIXED[r]) return FIXED[r];
  let h = 0;
  for (const c of r) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export const roleStyle = (role: string) => ({ '--role': roleColor(role) }) as CSSProperties;

export function Avatar({ user, size }: { user: Pick<TestUser, 'name' | 'role'>; size?: 'sm' | 'lg' }) {
  return (
    <span className={`avatar ${size ?? ''}`} style={roleStyle(user.role)} aria-hidden>
      {initials(user.name) || '?'}
    </span>
  );
}

export function RoleBadge({ role }: { role: string }) {
  return (
    <span className="role" style={roleStyle(role)}>
      {role.replace(/-/g, ' ')}
    </span>
  );
}

export const DEFAULT_ROLES = ['admin', 'sales', 'support', 'customer'];

/** Unique roles: project-configured first, then those in use, then defaults. */
export function knownRoles(users: TestUser[], configured?: string[]): string[] {
  const out: string[] = [];
  for (const r of [...(configured ?? []), ...users.map((u) => u.role), ...DEFAULT_ROLES]) if (r && !out.includes(r)) out.push(r);
  return out;
}

export interface RoleCount {
  role: string;
  count: number;
}

/** Editable list of role + count rows, used when generating users. */
export function RoleCountsEditor({ value, onChange, suggestions }: { value: RoleCount[]; onChange: (v: RoleCount[]) => void; suggestions: string[] }) {
  const set = (i: number, patch: Partial<RoleCount>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const total = value.reduce((n, r) => n + (r.count || 0), 0);
  const unused = suggestions.filter((s) => !value.some((v) => v.role === s));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.map((r, i) => (
        <div key={i} className="row nowrap">
          <span className="role-dot" style={roleStyle(r.role || 'user')} />
          <input value={r.role} onChange={(e) => set(i, { role: e.target.value })} list="role-suggestions" placeholder="role, e.g. sales" aria-label="Role" />
          <input type="number" min={0} max={200} value={r.count} onChange={(e) => set(i, { count: Number(e.target.value) })} style={{ width: 80 }} aria-label="Count" />
          <button type="button" className="btn sm ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove role">
            ✕
          </button>
        </div>
      ))}
      <datalist id="role-suggestions">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <div className="row">
        <button type="button" className="btn sm" onClick={() => onChange([...value, { role: unused[0] ?? '', count: 1 }])}>
          + Add role
        </button>
        <span className="spacer" />
        <span className="small faint">{total} users · the first of each role is pinned (up to 4)</span>
      </div>
    </div>
  );
}

// ---------- menu ----------
/**
 * Button with a drop-down menu. `floating` renders the menu in a portal with fixed positioning (from the button's rect),
 * so a card with overflow hidden can't clip it; it opens upward when there is no room below and stays inside the viewport.
 */
export function Menu({
  label,
  children,
  className,
  floating,
  align = 'end',
  menuClassName,
  title,
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  className?: string;
  floating?: boolean;
  /** Floating menus: 'end' right-aligns the menu with the button (default), 'start' left-aligns it. */
  align?: 'start' | 'end';
  /** Extra class on the menu panel (floating menus are portaled to body, so style them through this). */
  menuClassName?: string;
  /** Tooltip and accessible name of the button (icon-only labels). */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || !floating) return setPos(null);
    const place = () => {
      const btn = ref.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!btn || !menu) return;
      const m = 8;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      // Right-aligned with the button, like the inline menu (or left-aligned with align="start"); clamped to the viewport.
      const left = Math.min(Math.max(m, align === 'start' ? btn.left : btn.right - w), vw - w - m);
      const below = vh - btn.bottom - m;
      const above = btn.top - m;
      const up = h + 4 > below && above > below;
      const top = up ? Math.max(m, btn.top - 4 - h) : Math.min(btn.bottom + 4, Math.max(m, vh - h - m));
      setPos({ position: 'fixed', left, top, right: 'auto', maxHeight: (up ? above : below) > h ? undefined : Math.max(above, below) - 4, overflowY: 'auto' });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, floating, align]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Close and give focus back to the button when it was inside the menu (keyboard users).
      const inside = menuRef.current?.contains(document.activeElement) || ref.current?.contains(document.activeElement);
      setOpen(false);
      if (inside) ref.current?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
    };
    // Keyboard opening: move focus to the first item so Tab / arrows stay in the menu.
    const t = window.setTimeout(() => {
      if (!ref.current?.contains(document.activeElement)) return;
      menuRef.current?.querySelector<HTMLElement>('a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])')?.focus({ preventScroll: true });
    }, 0);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={className ?? 'btn sm'} onClick={() => setOpen(!open)} aria-expanded={open} title={title} aria-label={title}>
        {label}
      </button>
      {open &&
        (floating ? (
          createPortal(
            <div ref={menuRef} className={`menu menu-floating ${menuClassName ?? ''}`} role="menu" style={pos ?? { position: 'fixed', top: 0, left: 0, right: 'auto', visibility: 'hidden' }}>
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        ) : (
          <div ref={menuRef} className={`menu ${menuClassName ?? ''}`} role="menu">
            {children(() => setOpen(false))}
          </div>
        ))}
    </div>
  );
}

// ---------- local storage ----------
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  return [v, set];
}

// ---------- icons ----------
const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  inbox: (
    <>
      <path d="M3 13h5l1.5 3h5L16 13h5" />
      <path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  plug: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  code: <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  folder: <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M17.9 17.9A10 10 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 5.1-5.9M9.9 5.2A9 9 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2" />
      <path d="m2 2 20 20" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  paperclip: <path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6 15h4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  braces: <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2v2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2v2a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />,
  sparkle: (
    <>
      <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" />
      <path d="M19 16v4M17 18h4" />
    </>
  ),
  webhook: (
    <>
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </>
  ),
  reply: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  'list-checks': <path d="m3 7 2 2 4-4M3 17l2 2 4-4M13 6h8M13 12h8M13 18h8" />,
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8.5 5.5 3.5-5.5 3.5z" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-8 8H4l1.8-3A8 8 0 1 1 21 12zM8.5 10h7M8.5 14h4" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m21 16-5-5-9 9" />
    </>
  ),
  sliders: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />,
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className ?? 'icon'} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}
