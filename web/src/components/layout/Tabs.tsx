import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Icon } from '../people';
import { useFocusTrap, usePhone } from './hooks';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  /** Plain-text label for the phone select and the overflow menu (defaults to label when it is a string). */
  text?: string;
  /** Count badge (page/segmented: .tab-n; filter: .n). null/undefined hides it, 0 shows a muted zero when zero is set. */
  count?: number | null;
  /** Show the count even when it is 0 (muted). */
  zero?: boolean;
  /** Extra inline content after the label (status dot, sub-label). */
  extra?: ReactNode;
  icon?: ReactNode;
  title?: string;
  /** Render as a router link (tabs that are routes). */
  to?: string;
  disabled?: boolean;
}

export type TabsVariant = 'page' | 'segmented' | 'filter';

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange?: (id: T) => void;
  /** page: under the header; segmented: inside a card (max 4); filter: chips with counts (scrolls, never wraps). */
  variant?: TabsVariant;
  /** Accessible name of the tab list, also the prefix of the phone select ("Section: Active"). */
  label: string;
  className?: string;
  /** Phones: page tabs with more than 3 items become a select-style button (default true). */
  phoneSelect?: boolean;
  /** Overflow menu "More (n)" at >= 640 px when the tabs do not fit (page variant, default true). */
  overflow?: boolean;
  /** Render as <nav> (link tabs). */
  as?: 'div' | 'nav';
  /** id of the panel the tabs control (aria-controls). */
  panelId?: string;
}

const textOf = (t: TabItem) => t.text ?? (typeof t.label === 'string' ? t.label : t.id);

/**
 * One tab component for every strip: page tabs, segmented controls and filter chips. Roving tabindex with
 * Left/Right/Home/End; the selection itself stays in the caller (usually ?tab= in the URL).
 * Classes: .tabs/.tab (page), .seg/.seg-btn (segmented), .chips/.chip (filter); counts .tab-n / .n.
 */
export function Tabs<T extends string>({ items, value, onChange, variant = 'page', label, className = '', phoneSelect = true, overflow = true, as = 'div', panelId }: TabsProps<T>) {
  const phone = usePhone();
  if (variant === 'page' && phone && phoneSelect && items.length > 3) return <PhoneSelect items={items} value={value} onChange={onChange} label={label} className={className} />;
  if (variant === 'page' && phone && items.length > 1 && items.length <= 3) return <Strip items={items} value={value} onChange={onChange} label={label} className={`${className} tabs-equal`} variant="page" as={as} panelId={panelId} measure={false} />;
  return <Strip items={items} value={value} onChange={onChange} label={label} className={className} variant={variant} as={as} panelId={panelId} measure={variant === 'page' && overflow && !phone} />;
}

function Strip<T extends string>({ items, value, onChange, label, className, variant, as, panelId, measure }: { items: readonly TabItem<T>[]; value: T; onChange?: (id: T) => void; label: string; className: string; variant: TabsVariant; as: 'div' | 'nav'; panelId?: string; measure: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<number>(0);
  // Overflow: hide trailing tabs that do not fit (never the active one) behind a "More (n)" menu.
  useLayoutEffect(() => {
    if (!measure) return setHidden(0);
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // The strip may be sized to its content (pill track), so the room is measured on its parent.
    const box = el.parentElement ?? el;
    const room = () => box.clientWidth - (box === el ? 0 : 8);
    const fit = () => {
      const tabs = [...el.querySelectorAll<HTMLElement>(':scope > [data-tab]')];
      if (!tabs.length) return;
      const avail = room() - 110; // room for the More button
      let used = 0;
      let n = 0;
      const total = tabs.reduce((a, t) => a + t.offsetWidth + 4, 0) + 8;
      if (total <= room()) return setHidden(0);
      for (const t of tabs) {
        used += t.offsetWidth + 4;
        if (used > avail) n++;
      }
      setHidden(n);
    };
    // Measure with every tab rendered.
    setHidden(0);
    const ro = new ResizeObserver(() => {
      setHidden(0);
      requestAnimationFrame(fit);
    });
    ro.observe(box);
    requestAnimationFrame(fit);
    return () => ro.disconnect();
  }, [measure, items.length]);

  const activeIdx = Math.max(0, items.findIndex((t) => t.id === value));
  let visible = items.map((t, i) => ({ t, i }));
  let overflowItems: { t: TabItem<T>; i: number }[] = [];
  if (hidden > 0) {
    const keep = items.length - hidden;
    overflowItems = visible.slice(keep);
    visible = visible.slice(0, keep);
    // The active tab always stays visible: swap it with the last visible one.
    const ai = overflowItems.findIndex((x) => x.i === activeIdx);
    if (ai >= 0 && visible.length) {
      const last = visible.pop()!;
      visible.push(overflowItems[ai]);
      overflowItems.splice(ai, 1, last);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const els = [...(ref.current?.querySelectorAll<HTMLElement>(':scope > [data-tab]') ?? [])];
    const cur = els.indexOf(document.activeElement as HTMLElement);
    if (cur < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : (cur + (e.key === 'ArrowRight' ? 1 : -1) + els.length) % els.length;
    els[next]?.focus();
  };

  const base = variant === 'segmented' ? 'seg' : variant === 'filter' ? 'chips ui-filter' : 'tabs';
  const itemCls = variant === 'segmented' ? 'seg-btn' : variant === 'filter' ? 'chip' : 'tab';
  const countCls = variant === 'filter' ? 'n' : 'tab-n';
  const Wrap = as;
  return (
    <Wrap ref={ref as never} className={`${base} ui-tabs ui-tabs-${variant} ${className}`} role={as === 'nav' ? undefined : 'tablist'} aria-label={label} onKeyDown={onKey}>
      {visible.map(({ t }) => {
        const active = t.id === value;
        const inner = (
          <>
            {t.icon}
            <span className="tab-label">{t.label}</span>
            {t.extra}
            {t.count !== undefined && t.count !== null && (t.count > 0 || t.zero) && <span className={`${countCls} ${t.count ? '' : 'zero'}`}>{t.count}</span>}
          </>
        );
        const common = {
          'data-tab': t.id,
          className: `${itemCls} ${active ? 'active' : ''}`,
          title: t.title,
          tabIndex: active ? 0 : -1,
        };
        if (t.to)
          return (
            <Link key={t.id} {...common} to={t.to} role={as === 'nav' ? undefined : 'tab'} aria-selected={as === 'nav' ? undefined : active} aria-current={active ? 'page' : undefined} onClick={() => onChange?.(t.id)}>
              {inner}
            </Link>
          );
        return (
          <button key={t.id} type="button" {...common} role="tab" aria-selected={active} aria-controls={panelId} disabled={t.disabled} onClick={() => onChange?.(t.id)}>
            {inner}
          </button>
        );
      })}
      {overflowItems.length > 0 && <OverflowMenu items={overflowItems.map((x) => x.t)} value={value} onChange={onChange} />}
    </Wrap>
  );
}

function OverflowMenu<T extends string>({ items, value, onChange }: { items: TabItem<T>[]; value: T; onChange?: (id: T) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = menu.current?.offsetWidth ?? 220;
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - w, document.documentElement.clientWidth - w - 8)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !btn.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && (setOpen(false), btn.current?.focus());
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <>
      <button ref={btn} type="button" className="tab tab-more" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        More ({items.length}) <Icon name="chevronDown" size={12} />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="menu menu-floating" role="menu" style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
            {items.map((t) =>
              t.to ? (
                <Link key={t.id} role="menuitem" className={`menu-link ${t.id === value ? 'active' : ''}`} to={t.to} onClick={() => (setOpen(false), onChange?.(t.id))}>
                  {textOf(t)}
                  {!!t.count && <span className="sub">{t.count}</span>}
                </Link>
              ) : (
                <button key={t.id} type="button" role="menuitem" className={t.id === value ? 'active' : ''} onClick={() => (setOpen(false), onChange?.(t.id))}>
                  {textOf(t)}
                  {!!t.count && <span className="sub">{t.count}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Phones: one full-width button "Label: Active (count)" that opens a bottom sheet with every tab. */
function PhoneSelect<T extends string>({ items, value, onChange, label, className }: { items: readonly TabItem<T>[]; value: T; onChange?: (id: T) => void; label: string; className: string }) {
  const [open, setOpen] = useState(false);
  const active = items.find((t) => t.id === value) ?? items[0];
  return (
    <div className={`tabs-select-wrap ${className}`}>
      <button type="button" className="tabs-select" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} role="tab" aria-selected="true">
        <span className="tabs-select-label">{label}:</span>
        <span className="tabs-select-value">
          {active ? textOf(active) : ''}
          {!!active?.count && <span className="tab-n">{active.count}</span>}
        </span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && <TabSheet items={items} value={value} label={label} onPick={(id) => (setOpen(false), onChange?.(id))} onClose={() => setOpen(false)} />}
    </div>
  );
}

function TabSheet<T extends string>({ items, value, label, onPick, onClose }: { items: readonly TabItem<T>[]; value: T; label: string; onPick: (id: T) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="overlay sheet-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={label}>
        <div className="sheet-head">
          <span className="grow">{label}</span>
          <button type="button" className="btn sm ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="sheet-list" role="listbox" aria-label={label}>
          {items.map((t) => {
            const content = (
              <>
                {t.icon}
                <span className="grow">{textOf(t)}</span>
                {!!t.count && <span className="tab-n">{t.count}</span>}
                {t.id === value && <Icon name="check" size={14} />}
              </>
            );
            return t.to ? (
              <Link key={t.id} to={t.to} role="option" aria-selected={t.id === value} className={`sheet-item ${t.id === value ? 'active' : ''}`} onClick={() => onPick(t.id)}>
                {content}
              </Link>
            ) : (
              <button key={t.id} type="button" role="option" aria-selected={t.id === value} className={`sheet-item ${t.id === value ? 'active' : ''}`} disabled={t.disabled} onClick={() => onPick(t.id)}>
                {content}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Tab panel wrapper with the matching role (optional; pages can keep rendering content directly). */
export function TabPanel({ id, label, children, className }: { id?: string; label?: string; children: ReactNode; className?: string }) {
  return (
    <div id={id} role="tabpanel" aria-label={label} className={className}>
      {children}
    </div>
  );
}
