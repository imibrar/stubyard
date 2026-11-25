import type { PayPageInput } from '../pages.js';
import type { Payment, PaymentInstance } from '../repo.js';
import type { PaymentService } from '../service.js';
import { apsLayout } from '../aps/experience.js';
import { checkoutLayout } from '../checkout/experience.js';
import { geideaLayout } from '../geidea/experience.js';
import { hyperpayLayout } from '../hyperpay/experience.js';
import { moyasarLayout } from '../moyasar/experience.js';
import { myfatoorahLayout } from '../myfatoorah/experience.js';
import { paypalLayout } from '../paypal/experience.js';
import { paytabsLayout } from '../paytabs/experience.js';
import { stripeLayout } from '../stripe/experience.js';
import { tapLayout } from '../tap/experience.js';
import { tabbyLayout } from '../tabby/experience.js';
import { tamaraLayout } from '../tamara/experience.js';
import { jazzcashLayout } from '../jazzcash/experience.js';
import { easypaisaLayout } from '../easypaisa/experience.js';
import type { ProviderLayout } from './layout.js';
import { relFromPage, type KitPayCtx, type KitRel } from './context.js';
import { renderGenericPay, renderKitResult, resultOf, type KitStepCommon } from './pages.js';
import { hostedModeOf, layoutFor, type LayoutId } from './registry.js';
import { resolveView, type CheckoutView } from './view.js';
import type { Locale } from './i18n.js';

/**
 * Where the classic renderers (pages.ts) find out whether a payment page should be the realistic kit page.
 * renderPayPage / renderDonePage receive only display data, so each PaymentService registers itself here and the
 * renderer looks the payment up by id (several hubs can run in one process, e.g. in tests).
 */

const SOURCES = new Set<PaymentService>();

export function registerPageSource(svc: PaymentService): () => void {
  SOURCES.add(svc);
  return () => SOURCES.delete(svc);
}

export interface Located {
  svc: PaymentService;
  payment: Payment;
  inst: PaymentInstance;
  merchant: string;
  host: string | null;
}

export function locate(paymentId: string): Located | null {
  for (const svc of SOURCES) {
    try {
      const payment = svc.repo.get(paymentId);
      if (!payment) continue;
      const inst = svc.repo.instanceById(payment.instanceId);
      const project = svc.hub.projects.get(payment.projectId);
      if (!inst || !project) continue;
      return { svc, payment, inst, merchant: project.name, host: hostOf(svc, inst) };
    } catch {
      // a closed hub's database: skip it
    }
  }
  return null;
}

export function hostOf(svc: PaymentService, inst?: PaymentInstance): string | null {
  try {
    return new URL(svc.browserRoot(inst)).host;
  } catch {
    return null;
  }
}

/** The provider layouts (P0: Stripe; P1: the redirect hosted pages; P3: BNPL and wallets). Gateways without one use the generic kit page. */
const LAYOUTS: Record<LayoutId, ProviderLayout> = {
  'stripe-hosted': stripeLayout,
  'checkout-hpp': checkoutLayout,
  'paytabs-hpp': paytabsLayout,
  'aps-hosted': apsLayout,
  'tap-hosted': tapLayout,
  'myfatoorah-hosted': myfatoorahLayout,
  'moyasar-invoice': moyasarLayout,
  'paypal-approval': paypalLayout,
  'geidea-hpp': geideaLayout,
  'hyperpay-widget': hyperpayLayout,
  'tabby-hpp': tabbyLayout,
  'tamara-hpp': tamaraLayout,
  'jazzcash-hosted': jazzcashLayout,
  'easypaisa-hosted': easypaisaLayout,
};

/** The provider layout of a preset's hosted page, or null (generic kit page). */
export function layoutOf(preset: string): ProviderLayout | null {
  const id = layoutFor(preset);
  return id === 'generic' ? null : (LAYOUTS[id] ?? null);
}

/** The realistic pay page (provider layout or the generic kit page). */
export function renderKitPay(c: KitPayCtx): string {
  const def = layoutOf(c.input.presetId);
  if (def && (!c.input.embed || def.embedOk)) return def.renderPay(c);
  return renderGenericPay(c);
}

/** renderPayPage hook: the kit page when the payment's view is realistic, else null (classic). */
export function kitPayPage(i: PayPageInput): string | null {
  const hit = locate(i.paymentId);
  if (!hit) return null;
  const view = resolveView(hit.inst, hit.payment);
  if (view.ui !== 'realistic') return null;
  const def = layoutOf(hit.inst.preset);
  const payment = def?.prepare && (!i.embed || def.embedOk) ? def.prepare(hit.svc, hit.payment) : hit.payment;
  return renderKitPay({ input: i, payment, view, merchant: hit.merchant, host: hit.host, rel: relFromPage(payment.id), mode: hostedModeOf(hit.inst.preset) });
}

export function stepCommon(hit: Located, view: CheckoutView, rel: KitRel, o: { presetName: string; amount: string; dashboardUrl: string; logo?: string | null }): KitStepCommon {
  return { view, presetName: o.presetName, merchant: hit.merchant, amount: o.amount, host: hit.host, rel, dashboardUrl: o.dashboardUrl, logo: o.logo ?? null };
}

/** The page language of a classic page (lang / dir and the Arabic notice): the payment's view locale, else English. */
export function classicLocale(o: { paymentId?: string | null; dashboardUrl?: string | null }): Locale {
  const id = o.paymentId ?? (o.dashboardUrl ? /\/payments\/([^/?#]+)$/.exec(o.dashboardUrl)?.[1] : null);
  if (!id) return 'en';
  const hit = locate(decodeURIComponent(id));
  return hit ? resolveView(hit.inst, hit.payment).locale : 'en';
}

/**
 * renderDonePage hook (GET of a finished payment page): the kit result page for realistic views. The done page
 * input carries no payment id, only the dashboard link (…/payments/<id>), which names it.
 */
export function kitDonePage(i: { presetId: string; presetName: string; amount: string; status: string; returnUrl?: string | null; noReturn?: boolean; dashboardUrl: string; logo?: string | null; message: string }): string | null {
  const id = /\/payments\/([^/?#]+)$/.exec(i.dashboardUrl)?.[1];
  if (!id) return null;
  const hit = locate(decodeURIComponent(id));
  if (!hit) return null;
  const view = resolveView(hit.inst, hit.payment);
  if (view.ui !== 'realistic') return null;
  const r = resultOf(i.status, { presetId: i.presetId, async: !!hit.payment.providerData.async, declineMessage: i.message });
  const own = layoutOf(hit.inst.preset)?.doneScreen?.({ payment: hit.payment, svc: hit.svc, view, host: hit.host, merchant: hit.merchant, dashboardUrl: i.dashboardUrl, status: i.status, returnUrl: i.returnUrl ?? null, result: r });
  if (own) return own;
  return renderKitResult({ ...stepCommon(hit, view, relFromPage(hit.payment.id), i), ...r, status: i.status, returnUrl: i.returnUrl ?? null, noReturn: !!i.noReturn });
}
