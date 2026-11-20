import { registerExportSection } from '../maintenance/export.js';
import { GATEWAYS } from './presets.js';
import type { PaymentInstanceConfig } from './repo.js';

/**
 * Export / import of payment providers and project-level outcome rules (payments themselves are test data and are
 * not exported). Secret config (keys, webhook secrets, registered webhooks, the PayPal signing key) travels only with ?secrets=1; without
 * it an imported instance gets fresh credentials.
 */
let registered = false;
const LEGACY_SECRET_KEYS = ['secretKey', 'webhookSecret', 'serverKey', 'clientSecret', 'privateKeyPem', 'certPem', 'accessToken', 'webhookKey'];
/** The old list plus every gateway field marked secret (computed lazily: presets.ts may still be loading). */
let secretKeysCache: string[] | null = null;
const secretKeys = (): string[] =>
  // "webhooks": the Moyasar / Tabby / Tamara webhook registries carry shared secrets and auth headers.
  (secretKeysCache ??= [...new Set([...LEGACY_SECRET_KEYS, 'webhooks', ...GATEWAYS.flatMap((g) => g.fields.filter((f) => f.secret).map((f) => f.key))])]);

export function registerPaymentExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'paymentInstances',
    table: 'payment_instances',
    export: ({ hub, project }) =>
      hub.payments.repo.listInstances(project.id).map((i) => {
        const config: Record<string, unknown> = { ...i.config };
        for (const k of secretKeys()) delete config[k];
        return { id: i.id, slug: i.slug, name: i.name, preset: i.preset, enabled: i.enabled, config };
      }),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        try {
          const inst = ctx.hub.payments.createInstance(ctx.project, { preset: r.preset, slug: r.slug, name: r.name, enabled: r.enabled !== false, config: (r.config as PaymentInstanceConfig) ?? {} });
          if (r.id) ctx.ids.set('paymentInstances', String(r.id), inst.id);
          n++;
        } catch (e) {
          ctx.warnings.push(`Payment provider ${String(r.slug)} skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });

  registerExportSection({
    key: 'paymentSecrets',
    secret: true,
    clear: () => undefined,
    export: ({ hub, project }) =>
      hub.payments.repo.listInstances(project.id).map((i) => ({
        instanceId: i.id,
        slug: i.slug,
        config: Object.fromEntries(secretKeys().filter((k) => (i.config as Record<string, unknown>)[k] !== undefined).map((k) => [k, (i.config as Record<string, unknown>)[k]])),
      })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const id = ctx.ids.get('paymentInstances', String(r.instanceId ?? ''));
        const inst = id ? ctx.hub.payments.repo.instanceById(id) : ctx.hub.payments.repo.getInstance(ctx.project.id, String(r.slug ?? ''));
        if (!inst) continue;
        ctx.hub.payments.repo.updateInstance(inst.id, { config: { ...inst.config, ...((r.config as PaymentInstanceConfig) ?? {}) } });
        n++;
      }
      return n;
    },
  });

  registerExportSection({
    key: 'paymentRules',
    clear: () => undefined, // cascades from payment_instances / project
    export: ({ hub, project }) =>
      hub.payments.repo
        .listRules(project.id, { all: true })
        .filter((r) => !r.runId)
        .map((r) => ({ instanceId: r.instanceId, userId: r.testUserId, outcome: r.outcome, count: r.remaining, after: r.skipCount || undefined, until: r.expiresAt, label: r.label })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const instanceId = r.instanceId ? ctx.ids.get('paymentInstances', String(r.instanceId)) : null;
        const userId = r.userId ? ctx.ids.get('users', String(r.userId)) : null;
        if ((r.instanceId && !instanceId) || (r.userId && !userId)) {
          ctx.warnings.push(`Payment rule "${String(r.outcome)}" skipped: its provider or user is missing`);
          continue;
        }
        if (r.count === 0 || (r.until && String(r.until) <= new Date().toISOString())) continue;
        ctx.hub.payments.repo.addRule(ctx.project.id, {
          instanceId: instanceId ?? null,
          testUserId: userId ?? null,
          runId: null,
          outcome: String(r.outcome),
          remaining: r.count === null || r.count === undefined ? null : Number(r.count),
          skipCount: r.after ? Number(r.after) : 0,
          expiresAt: r.until ? String(r.until) : null,
          label: r.label ? String(r.label) : null,
        });
        n++;
      }
      return n;
    },
  });
}
