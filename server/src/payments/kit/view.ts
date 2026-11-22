import { HttpError } from '../../util.js';
import type { Json } from '../gateway.js';
import type { Payment, PaymentInstance } from '../repo.js';
import { pickLocale, type Locale } from './i18n.js';

/**
 * Which checkout view a payment page shows, and in which language / timings.
 *
 * Instance config (open JSON, no migration):
 * - experience: "realistic" | "classic". An absent key means classic: instances created before this feature (and
 *   imports of old exports) keep today's page; new instances are created with "realistic".
 * - pageLocale: "auto" (default: the provider's own locale parameter, else English) | "en" | "ar".
 * - pageTimings: "auto" (default: short realistic delays for people, none when navigator.webdriver is true) |
 *   "realistic" | "fast".
 * - pageDrawer: "closed" (default) | "open" (the Test controls drawer starts open, for scripted browser tests).
 *
 * Per payment, the page URL can override them (kept on the payment in providerData.checkoutView, so the next
 * screens follow): ?ui=classic|realistic, ?stubyard_lang=en|ar, ?stubyard_drawer=open|closed.
 */

export type ExperienceKind = 'realistic' | 'classic';
export type Timings = 'auto' | 'realistic' | 'fast';

export interface CheckoutView {
  ui: ExperienceKind;
  locale: Locale;
  timings: Timings;
  drawerOpen: boolean;
}

export const EXPERIENCE_CONFIG = {
  experience: ['realistic', 'classic'],
  pageLocale: ['auto', 'en', 'ar'],
  pageTimings: ['auto', 'realistic', 'fast'],
  pageDrawer: ['closed', 'open'],
} as const;

/** Validates the checkout keys of an instance config (400 on a bad value); "" removes a key. */
export function cleanExperienceConfig(c: Json): void {
  for (const [k, allowed] of Object.entries(EXPERIENCE_CONFIG)) {
    if (c[k] === undefined || c[k] === null) continue;
    const v = String(c[k]).trim().toLowerCase();
    if (v === '') {
      delete c[k];
      continue;
    }
    if (!(allowed as readonly string[]).includes(v)) throw new HttpError(400, `${k} must be one of ${allowed.join(', ')}`);
    c[k] = v;
  }
}

/** The provider's own language parameter of the create request, where the gateway stores one. */
function providerLocale(p: Payment): unknown[] {
  const pd = p.providerData ?? {};
  const rq = (p.request ?? {}) as Json;
  const nested = (o: unknown, ...keys: string[]): unknown => {
    let cur: unknown = o;
    for (const k of keys) cur = cur && typeof cur === 'object' ? (cur as Json)[k] : undefined;
    return cur;
  };
  return [
    pd.locale, pd.language, pd.lang,
    rq.locale, rq.language, rq.lang, rq.paypage_lang, rq.Language, rq.pp_Language,
    nested(rq, 'lang'), nested(rq, 'payment', 'lang'), nested(rq, 'merchant_url', 'lang'), nested(rq, 'order', 'locale'),
    nested(rq, 'application_context', 'locale'), nested(rq, 'experience_context', 'locale'),
  ];
}

export function resolveView(inst: PaymentInstance, p: Payment): CheckoutView {
  const c = inst.config as Json;
  const ov = (p.providerData?.checkoutView ?? {}) as Json;
  const ui = (ov.ui === 'classic' || ov.ui === 'realistic' ? ov.ui : c.experience === 'realistic' ? 'realistic' : 'classic') as ExperienceKind;
  const locale = pickLocale(ov.locale, c.pageLocale, ...providerLocale(p));
  const timings = (['auto', 'realistic', 'fast'].includes(String(c.pageTimings)) ? c.pageTimings : 'auto') as Timings;
  const drawerOpen = ov.drawer === 'open' ? true : ov.drawer === 'closed' ? false : c.pageDrawer === 'open';
  return { ui, locale, timings, drawerOpen };
}

/** The page URL overrides of a request as a query string ("" or "?stubyard_lang=ar&…"), for entry URLs that redirect to the page. */
export function viewQueryString(q: Record<string, unknown>): string {
  const out = new URLSearchParams();
  for (const k of ['ui', 'stubyard_ui', 'stubyard_lang', 'stubyard_drawer']) {
    const v = q[k];
    if (typeof v === 'string' && /^[A-Za-z]{2,10}$/.test(v)) out.set(k, v);
  }
  const s = out.toString();
  return s ? '?' + s : '';
}

/** Page URL overrides (?ui=, ?stubyard_lang=, ?stubyard_drawer=) as the providerData.checkoutView patch, or null. */
export function viewFromQuery(q: Record<string, string | undefined>): Json | null {
  const out: Json = {};
  const ui = (q.ui ?? q.stubyard_ui)?.toLowerCase();
  if (ui === 'classic' || ui === 'realistic') out.ui = ui;
  const lang = q.stubyard_lang?.toLowerCase();
  if (lang === 'en' || lang === 'ar') out.locale = lang;
  const drawer = q.stubyard_drawer?.toLowerCase();
  if (drawer === 'open' || drawer === 'closed') out.drawer = drawer;
  return Object.keys(out).length ? out : null;
}
