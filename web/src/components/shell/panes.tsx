import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../people';
import { useMediaQuery } from '../layout/hooks';

/**
 * Relay panes. The shell owns two slots beside <main>: the list pane (left of the detail) and the context panel
 * (right). Pages fill them with <ListPane> / <ContextPane>, which portal their content into the slots, so a page keeps
 * its state and data in one component while the shell decides where each part sits on each screen size.
 *
 *   >= 1024 px   list pane inline (320 px, 360 px from 1920); context inline from 1536 px (toggle with "]"), overlay below.
 *   <  1024 px   list pane is a sheet opened from the global header (or rendered inline in <main> with narrow="inline").
 */
export interface ListInfo {
  title: string;
  count?: number;
  narrow: 'sheet' | 'inline' | 'hide';
  /** 'menu': a short section menu (settings, system) gets a narrower pane. */
  size?: 'list' | 'menu';
}

interface PaneState {
  listEl: HTMLElement | null;
  contextEl: HTMLElement | null;
  list: ListInfo | null;
  setList: (l: ListInfo | null) => void;
  context: string | null;
  setContext: (title: string | null) => void;
  listOpen: boolean;
  setListOpen: (o: boolean) => void;
  contextOpen: boolean;
  setContextOpen: (o: boolean) => void;
}

const PaneCtx = createContext<PaneState | null>(null);
export const usePanes = () => useContext(PaneCtx);

const CTX_KEY = 'stubyard.contextOpen';

/** Pane state for the shell; returns the provider value plus the slot ref setters. */
export function usePaneState() {
  const [listEl, listRef] = useState<HTMLElement | null>(null);
  const [contextEl, contextRef] = useState<HTMLElement | null>(null);
  const [list, setList] = useState<ListInfo | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const wide = useMediaQuery('(width >= 1536px)');
  const [pref, setPref] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(CTX_KEY);
      return v === null ? null : v === 'true';
    } catch {
      return null;
    }
  });
  // Wide screens: shown unless the user hid it. Narrower: an overlay that starts closed.
  const [overlayOpen, setOverlayOpen] = useState(false);
  const contextOpen = wide ? pref ?? true : overlayOpen;
  const setContextOpen = (o: boolean) => {
    if (wide) {
      setPref(o);
      try {
        localStorage.setItem(CTX_KEY, String(o));
      } catch {
        /* storage unavailable */
      }
    } else setOverlayOpen(o);
  };
  const value: PaneState = { listEl, contextEl, list, setList, context, setContext, listOpen, setListOpen, contextOpen, setContextOpen };
  return { value, listRef, contextRef, wide };
}

export const PaneProvider = PaneCtx.Provider;

/**
 * The list pane of the current section: header (title, count, actions), optional toolbar (search / quick filters)
 * and the list. Rendered into the shell's list slot; with narrow="inline" it renders in place below 1024 px.
 */
export function ListPane({ title, count, actions, toolbar, children, narrow = 'sheet', footer, label, size = 'list' }: { title: string; count?: number; actions?: ReactNode; toolbar?: ReactNode; children: ReactNode; narrow?: ListInfo['narrow']; footer?: ReactNode; label?: string; size?: ListInfo['size'] }) {
  const panes = usePanes();
  const wide = useMediaQuery('(width >= 1024px)');
  const setList = panes?.setList;
  useLayoutEffect(() => {
    setList?.({ title, count, narrow, size });
  }, [setList, title, count, narrow, size]);
  useEffect(() => () => setList?.(null), [setList]);
  const body = (
    <section className="list-pane-inner" aria-label={label ?? title}>
      <div className="pane-head">
        <h2 className="pane-title">
          {title}
          {count !== undefined && <span className="pane-count">{count}</span>}
        </h2>
        <div className="pane-actions">
          {actions}
          {!wide && narrow === 'sheet' && (
            <button type="button" className="icon-btn" aria-label="Close list" title="Close" onClick={() => panes?.setListOpen(false)}>
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
      </div>
      {toolbar && <div className="pane-toolbar">{toolbar}</div>}
      <div className="pane-scroll">{children}</div>
      {footer && <div className="pane-foot">{footer}</div>}
    </section>
  );
  if (!panes?.listEl) return null;
  if (!wide && narrow === 'inline') return <div className="list-pane-inline">{body}</div>;
  if (!wide && narrow === 'hide') return null;
  return createPortal(body, panes.listEl);
}

/** Context panel (facts, copyable values, related links). Toggle: header button or "]". */
export function ContextPane({ title, children }: { title: string; children: ReactNode }) {
  const panes = usePanes();
  const setContext = panes?.setContext;
  useLayoutEffect(() => {
    setContext?.(title);
  }, [setContext, title]);
  useEffect(() => () => setContext?.(null), [setContext]);
  if (!panes?.contextEl) return null;
  return createPortal(
    <section className="context-inner" aria-label={title}>
      <div className="pane-head">
        <h2 className="pane-title">{title}</h2>
        <div className="pane-actions">
          <button type="button" className="icon-btn" aria-label="Hide details panel" title="Hide details (])" onClick={() => panes.setContextOpen(false)}>
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>
      <div className="pane-scroll context-body">{children}</div>
    </section>,
    panes.contextEl,
  );
}
