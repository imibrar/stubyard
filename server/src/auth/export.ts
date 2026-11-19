import { registerExportSection } from '../maintenance/export.js';
import type { AuthProviderConfig } from '../repos/auth.js';

/**
 * Export / import of login providers (registered sections, export.ts itself is untouched).
 * Identities are materialised for every user × provider before export so `sub` survives export → import even
 * though users get new ids. Signing keys are secrets (?secrets=1 only).
 */
let registered = false;

export function registerAuthExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'authProviders',
    table: 'auth_providers',
    export: ({ hub, project }) =>
      hub.auth.repo.listProviders(project.id).map((p) => ({ id: p.id, slug: p.slug, name: p.name, preset: p.preset, enabled: p.enabled, config: p.config })),
    import: (ctx, rows) => {
      for (const r of rows) {
        const p = ctx.hub.auth.repo.createProvider(ctx.project.id, {
          preset: String(r.preset ?? 'oidc'),
          slug: r.slug ? String(r.slug) : undefined,
          name: String(r.name ?? r.preset ?? 'Login'),
          config: (r.config as AuthProviderConfig) ?? {},
          enabled: r.enabled !== false,
        });
        if (r.id) ctx.ids.set('authProviders', String(r.id), p.id);
      }
      return rows.length;
    },
  });

  registerExportSection({
    key: 'authIdentities',
    clear: () => undefined, // cascades from auth_providers / test_users
    export: ({ hub, project }) => {
      const users = hub.users.list(project.id);
      const out: Record<string, unknown>[] = [];
      for (const p of hub.auth.repo.listProviders(project.id)) {
        for (const u of users) {
          const i = hub.auth.ensureIdentity(p, u);
          out.push({ provider: p.slug, providerId: p.id, userId: u.id, sub: i.sub, claims: i.claims, consented: i.consented });
        }
      }
      return out;
    },
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const providerId = ctx.ids.get('authProviders', r.providerId as string) ?? ctx.hub.auth.repo.getProvider(ctx.project.id, String(r.provider ?? ''))?.id ?? null;
        const userId = ctx.ids.get('users', r.userId as string);
        if (!providerId || !userId) {
          ctx.warnings.push(`Login identity ${r.sub} skipped: its provider or user is missing`);
          continue;
        }
        const existing = ctx.hub.auth.repo.getIdentity(providerId, userId);
        if (existing) ctx.hub.auth.repo.updateIdentity(existing, { sub: String(r.sub), claims: (r.claims as Record<string, unknown>) ?? {}, consented: r.consented === true });
        else ctx.hub.auth.repo.insertIdentity(providerId, userId, String(r.sub), (r.claims as Record<string, unknown>) ?? {}, r.consented === true);
        n++;
      }
      return n;
    },
  });

  registerExportSection({
    key: 'authRules',
    clear: () => undefined,
    export: ({ hub, project }) => {
      const out: Record<string, unknown>[] = [];
      for (const p of hub.auth.repo.listProviders(project.id)) {
        for (const r of hub.auth.repo.allRules(p.id)) {
          out.push({
            provider: p.slug,
            providerId: p.id,
            userId: r.testUserId,
            stage: r.stage,
            action: r.action,
            params: r.params,
            count: r.remainingCount,
            after: r.skipCount || undefined,
            until: r.expiresAt,
            label: r.label,
            enabled: r.enabled,
          });
        }
      }
      return out;
    },
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const providerId = ctx.ids.get('authProviders', r.providerId as string);
        const p = providerId ? ctx.hub.auth.repo.getProvider(ctx.project.id, providerId) : ctx.hub.auth.repo.getProvider(ctx.project.id, String(r.provider ?? ''));
        if (!p) {
          ctx.warnings.push(`Login rule "${r.action}" skipped: provider ${r.provider} is missing`);
          continue;
        }
        const userId = r.userId ? ctx.ids.get('users', r.userId as string) : null;
        if (r.userId && !userId) {
          ctx.warnings.push(`Login rule "${r.action}" skipped: its user is missing`);
          continue;
        }
        if (r.count === 0) continue;
        if (r.until && String(r.until) <= new Date().toISOString()) continue;
        ctx.hub.auth.repo.addRule(p, userId, {
          action: String(r.action),
          stage: r.stage ? String(r.stage) : undefined,
          params: (r.params as Record<string, unknown>) ?? {},
          count: r.count === null || r.count === undefined ? null : Number(r.count),
          after: r.after ? Number(r.after) : null,
          until: r.until ? String(r.until) : null,
          label: r.label ? String(r.label) : null,
          enabled: r.enabled !== false,
        });
        n++;
      }
      return n;
    },
  });

  registerExportSection({
    key: 'authKeys',
    secret: true,
    clear: () => undefined,
    export: ({ hub, project }) => {
      const out: Record<string, unknown>[] = [];
      for (const p of hub.auth.repo.listProviders(project.id)) {
        for (const k of hub.auth.repo.listKeys(p.id).reverse()) {
          out.push({ provider: p.slug, providerId: p.id, kid: k.kid, alg: k.alg, privatePem: k.privatePem, publicJwk: k.publicJwk, certPem: k.certPem, status: k.status, createdAt: k.createdAt, retiredAt: k.retiredAt });
        }
      }
      return out;
    },
    import: (ctx, rows) => {
      const touched = new Set<string>();
      let n = 0;
      for (const r of rows) {
        const providerId = ctx.ids.get('authProviders', r.providerId as string) ?? ctx.hub.auth.repo.getProvider(ctx.project.id, String(r.provider ?? ''))?.id;
        if (!providerId || !r.privatePem || !r.kid) continue;
        if (!touched.has(providerId)) {
          // The provider got a fresh key on creation; the exported keys replace it.
          ctx.hub.auth.repo.retireKeys(providerId, true);
          touched.add(providerId);
        }
        ctx.hub.auth.repo.insertKey(providerId, {
          kid: String(r.kid),
          alg: String(r.alg ?? 'RS256'),
          privatePem: String(r.privatePem),
          publicJwk: r.publicJwk,
          certPem: r.certPem ? String(r.certPem) : null,
          status: r.status === 'retired' ? 'retired' : 'active',
          createdAt: r.createdAt ? String(r.createdAt) : undefined,
          retiredAt: r.retiredAt ? String(r.retiredAt) : null,
        });
        n++;
      }
      return n;
    },
  });
}
