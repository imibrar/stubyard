import { useEffect, useRef, useState, type RefObject } from 'react';

/** Breakpoints of styles/tokens.css (keep in sync). */
export const BP = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536, '3xl': 1920 } as const;

/** Live result of a media query, e.g. useMediaQuery('(width < 640px)'). */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

/** True below the sm breakpoint (phones). */
export const usePhone = () => useMediaQuery(`(width < ${BP.sm}px)`);

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Dialog focus handling: moves focus into `ref` when it opens (unless something inside already has it, e.g. autoFocus),
 * keeps Tab / Shift+Tab inside, and gives focus back to the element that had it when the dialog closes.
 */
const trapStack: object[] = [];

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true) {
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const token = {};
    trapStack.push(token);
    restore.current = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      // Only the innermost open dialog handles Tab.
      if (e.key !== 'Tab' || !ref.current || trapStack[trapStack.length - 1] !== token) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = trapStack.indexOf(token);
      if (i >= 0) trapStack.splice(i, 1);
      const r = restore.current;
      if (r && document.contains(r)) setTimeout(() => r.focus({ preventScroll: true }), 0);
    };
  }, [ref, active]);
}

/** Width of an element, kept up to date with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
