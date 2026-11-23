// What the content script remembers about the page's sensitive fields (security review of R1, finding 2), for the
// recorder (rrweb's mask function) and video mode (dots over fields). It watches from the moment the content script
// runs, recording or not, so a password shown in clear later (a "show password" toggle, a field swapped for a text
// input, a new segment's snapshot after a pause) is still known to be one:
//  - every element ever seen as a password input (a WeakSet), also after its type changes;
//  - signatures of every password input seen (id, form + name, password autocomplete, form + position), so an input
//    that replaces one (same id, name or place) counts as a password too;
//  - fields the extension filled with a secret (setValue secret, or a fill into a sensitive field) and those values:
//    any field holding such a value is sensitive and page text showing it is masked.
// Its MutationObserver is registered before rrweb's, so it has seen a change before rrweb records it.
import { isSensitiveInput, type SensitiveMemory } from '../shared/recording';

const PW_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code)(\s|$)/i;
/** Values shorter than this are not remembered (they would match too much page text). */
const MIN_SECRET = 4;
const MAX_SECRETS = 50;

const isInput = (n: Node): n is HTMLInputElement | HTMLTextAreaElement => n.nodeType === 1 && ((n as Element).localName === 'input' || (n as Element).localName === 'textarea');

function formKey(el: Element): string {
  const f = (el as HTMLInputElement).form ?? el.closest('form');
  if (!f) return 'doc';
  return f.id ? `#${f.id}` : f.getAttribute('name') ? `n:${f.getAttribute('name')}` : `a:${f.getAttribute('action') ?? ''}`;
}

/** The place of an input among the inputs of its form (or of the document). */
function position(el: Element): number {
  const f = (el as HTMLInputElement).form ?? el.closest('form');
  const scope: ParentNode = f ?? el.ownerDocument ?? document;
  return Array.prototype.indexOf.call(scope.querySelectorAll('input, textarea'), el);
}

export function signaturesOf(el: Element, withPosition = true): string[] {
  const out: string[] = [];
  const fk = formKey(el);
  if (el.id) out.push(`id:${el.id}`);
  const name = el.getAttribute('name');
  if (name) out.push(`name:${fk}|${name}`);
  const ac = el.getAttribute('autocomplete') ?? '';
  if (PW_AUTOCOMPLETE.test(ac)) out.push(`ac:${fk}|${ac.trim().toLowerCase()}`);
  if (withPosition) {
    const p = position(el);
    if (p >= 0) out.push(`pos:${fk}#${p}`);
  }
  return out;
}

export class SensitiveTracker implements SensitiveMemory {
  private everPassword = new WeakSet<Element>();
  private marked = new WeakSet<Element>();
  private signatures = new Set<string>();
  private secrets: string[] = [];
  private observer: MutationObserver | null = null;
  private listeners = new Set<(els: Element[]) => void>();

  constructor(private doc: Document) {}

  /** Scan the page and watch it (idempotent). */
  start(): void {
    if (this.observer) return;
    this.scan(this.doc);
    const MO = this.doc.defaultView?.MutationObserver ?? (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (!MO) return;
    this.observer = new MO((records) => this.onMutations(records));
    this.observer.observe(this.doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Called with inputs that appeared or changed type (video mode re-checks them). */
  onChange(fn: (els: Element[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The extension is about to type a secret into this field (or did). */
  mark(el: Element | null | undefined, value?: string): void {
    if (!el) return;
    this.marked.add(el);
    if (value !== undefined) this.rememberValue(value);
  }

  rememberValue(value: string): void {
    if (typeof value !== 'string' || value.length < MIN_SECRET || this.secrets.includes(value)) return;
    this.secrets.push(value);
    if (this.secrets.length > MAX_SECRETS) this.secrets.shift();
  }

  isMarked(el: Element): boolean {
    if (this.marked.has(el) || this.everPassword.has(el)) return true;
    if (!isInput(el) || !this.signatures.size) return false;
    for (const s of signaturesOf(el)) if (this.signatures.has(s)) return true;
    return false;
  }

  isSecretValue(value: string): boolean {
    return value.length >= MIN_SECRET && this.secrets.includes(value);
  }

  secretValues(): readonly string[] {
    return this.secrets;
  }

  /** Is this field sensitive (the shared checks with this memory)? */
  isSensitive(el: Element, maskSelectors: readonly string[] = []): boolean {
    return isSensitiveInput(el, maskSelectors, this);
  }

  // -------------------------------------------------------------------------------------------------------------

  private notePassword(el: Element): void {
    this.everPassword.add(el);
    for (const s of signaturesOf(el)) this.signatures.add(s);
    if (this.signatures.size > 2000) this.signatures = new Set([...this.signatures].slice(-1000));
  }

  private scan(root: ParentNode): Element[] {
    const found: Element[] = [];
    const list = root instanceof Element && isInput(root) ? [root] : Array.from(root.querySelectorAll?.('input, textarea') ?? []);
    for (const el of list) {
      found.push(el);
      if ((el.getAttribute('type') ?? '').toLowerCase() === 'password') this.notePassword(el);
      else if (this.isMarked(el)) this.everPassword.add(el); // stands where a password input was
    }
    return found;
  }

  private onMutations(records: MutationRecord[]): void {
    const changed: Element[] = [];
    // Removed password inputs first: their signatures cover what replaces them in the same batch.
    for (const r of records) {
      for (const n of Array.from(r.removedNodes)) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        const inputs = isInput(el) ? [el] : Array.from(el.querySelectorAll?.('input') ?? []);
        for (const i of inputs) if (this.everPassword.has(i) || (i.getAttribute('type') ?? '').toLowerCase() === 'password') for (const s of signaturesOf(i, false)) this.signatures.add(s);
      }
    }
    for (const r of records) {
      if (r.type === 'attributes' && r.target.nodeType === 1) {
        const el = r.target as Element;
        const was = (r.oldValue ?? '').toLowerCase() === 'password';
        if (was || (el.getAttribute('type') ?? '').toLowerCase() === 'password') this.notePassword(el);
        if (isInput(el)) changed.push(el);
      } else if (r.type === 'childList') {
        for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1) changed.push(...this.scan(n as Element));
      }
    }
    if (changed.length) for (const fn of this.listeners) fn(changed);
  }
}
