// Clickjacking guard of the widget frame (security review item 1). The page around the frame can make the widget
// invisible while it stays clickable: opacity 0 or a transform on the host or on <html>, a filter, or its own element
// laid over the card. The host puts its own style back (content/widget.ts), but it cannot see the page's other
// elements. IntersectionObserver v2 can: with trackVisibility it reports isVisible = false whenever anything covers
// the frame or any ancestor (also across the frame boundary) has opacity, a filter or a non-trivial transform.
// The frame ignores clicks on its action controls unless it has been really visible for at least VISIBLE_MIN_MS, and
// says so ("Widget hidden by the page — use the panel"). Engines without v2 (isVisible undefined) are not gated.

/** How long the frame must have been visible before a click on an action control counts. */
export const VISIBLE_MIN_MS = 300;
/** IntersectionObserver v2 delay (the minimum allowed with trackVisibility is 100 ms). */
export const IO_DELAY_MS = 100;
/** The controls that act (buttons, links, toggles); clicks on text, inputs and empty space are never gated. */
export const GATED_SELECTOR = 'button, a[href], [role="button"], summary, input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"]';
/** While the frame is believed hidden, how often a fresh observer checks again. */
export const RECHECK_MS = 500;
export const HIDDEN_NOTICE = 'Widget hidden by the page — use the panel.';

/** The pure state: since when the frame has been visible (null: not visible now). */
export class VisibilityGate {
  private since: number | null = null;
  /** False until an observer entry told us isVisible (no v2: never gated). */
  supported = false;
  constructor(private readonly now: () => number = () => performance.now()) {}

  update(visible: boolean | undefined) {
    if (visible === undefined) return; // v1 only: no visibility information
    this.supported = true;
    if (!visible) this.since = null;
    else if (this.since === null) this.since = this.now();
  }

  /** Visible as far as the last entry said (false before any v2 entry). */
  get visible(): boolean {
    return this.since !== null;
  }

  allows(): boolean {
    if (!this.supported) return true;
    return this.since !== null && this.now() - this.since >= VISIBLE_MIN_MS;
  }
}

type IOEntry = { isVisible?: boolean; isIntersecting: boolean };
type IOCtor = new (cb: (entries: IOEntry[]) => void, opts: Record<string, unknown>) => { observe(el: Element): void; disconnect(): void };

export interface ClickGate {
  gate: VisibilityGate;
  dispose(): void;
}

/**
 * Observe `target` (the frame's root element) and gate clicks on action controls in `win` (capture phase on the
 * window, so it runs before React's handlers). `onBlocked` shows the notice.
 */
export function installClickGate(win: Window, target: Element, onBlocked: () => void, o: { IO?: IOCtor | null; now?: () => number } = {}): ClickGate {
  const gate = new VisibilityGate(o.now);
  const IO = o.IO === undefined ? ((win as unknown as { IntersectionObserver?: IOCtor }).IntersectionObserver ?? null) : o.IO;
  let io: InstanceType<IOCtor> | null = null;
  const observe = () => {
    if (!IO) return;
    io?.disconnect();
    try {
      io = new IO(
        (entries) => {
          const e = entries[entries.length - 1];
          if (!e) return;
          gate.update(e.isVisible === undefined ? undefined : e.isVisible && e.isIntersecting);
        },
        { trackVisibility: true, delay: IO_DELAY_MS, threshold: [0, 1] },
      );
      io.observe(target);
    } catch {
      io = null; // an engine that refuses the v2 options: not gated
    }
  };
  observe();
  // Chrome does not always send a new entry when the frame becomes visible again without its own box changing (the
  // host moved into a modal <dialog> while the dialog's backdrop had covered it for a moment): while the gate believes
  // the frame hidden, a fresh observer asks again (its first entry is the current state).
  const recheck = io ? win.setInterval(() => {
    if (io && gate.supported && !gate.visible) observe();
  }, RECHECK_MS) : 0;
  const onClick = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== 'function' || !t.closest(GATED_SELECTOR)) return;
    if (gate.allows()) return;
    e.stopPropagation();
    e.preventDefault();
    onBlocked();
  };
  win.addEventListener('click', onClick, true);
  return {
    gate,
    dispose: () => {
      win.removeEventListener('click', onClick, true);
      if (recheck) win.clearInterval(recheck);
      io?.disconnect();
    },
  };
}
