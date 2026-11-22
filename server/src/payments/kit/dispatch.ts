import type { PayPageInput } from '../pages.js';
import type { Payment, PaymentInstance } from '../repo.js';
import type { PaymentService } from '../service.js';
import { renderStripeHosted } from '../stripe/experience.js';
import { relFromPage, type KitPayCtx, type KitRel } from './context.js';
import { renderGenericPay, renderKitResult, resultOf, type KitStepCommon } from './pages.js';
import { hostedModeOf, layoutFor } from './registry.js';
import { resolveView, type CheckoutView } from './view.js';

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
      return { svc, payment, inst, merchant: project.name, host: hostOf(svc) };
    } catch {
      // a closed hub's database: skip it
    }
  }
  return null;
}

export function hostOf(svc: PaymentService): string | null {
  try {
    return new URL(svc.browserRoot()).host;
  } catch {
    return null;
  }
}

/** The realistic pay page (provider layout or the generic kit page). */
export function renderKitPay(c: KitPayCtx): string {
  if (!c.input.embed && layoutFor(c.input.presetId) === 'stripe-hosted') return renderStripeHosted(c);
  return renderGenericPay(c);
}

/** renderPayPage hook: the kit page when the payment's view is realistic, else null (classic). */
export function kitPayPage(i: PayPageInput): string | null {
  const hit = locate(i.paymentId);
  if (!hit) return null;
  const view = resolveView(hit.inst, hit.payment);
  if (view.ui !== 'realistic') return null;
  return renderKitPay({ input: i, payment: hit.payment, view, merchant: hit.merchant, host: hit.host, rel: relFromPage(hit.payment.id), mode: hostedModeOf(hit.inst.preset) });
}

export function stepCommon(hit: Located, view: CheckoutView, rel: KitRel, o: { presetName: string; amount: string; dashboardUrl: string; logo?: string | null }): KitStepCommon {
  return { view, presetName: o.presetName, merchant: hit.merchant, amount: o.amount, host: hit.host, rel, dashboardUrl: o.dashboardUrl, logo: o.logo ?? null };
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
  return renderKitResult({ ...stepCommon(hit, view, relFromPage(hit.payment.id), i), ...r, status: i.status, returnUrl: i.returnUrl ?? null, noReturn: !!i.noReturn });
}
