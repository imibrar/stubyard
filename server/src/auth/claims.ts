import type { Ctx, Profile } from './presets/types.js';

/** Default extraClaims of the generic OIDC preset, by flavour. */
export const FLAVOR_CLAIMS: Record<string, Record<string, unknown>> = {
  generic: { roles: ['{{user.role}}'] },
  auth0: {},
  okta: { groups: ['{{user.role}}'] },
  keycloak: { realm_access: { roles: ['{{user.role}}'] } },
  cognito: { 'cognito:groups': ['{{user.role}}'] },
};

/**
 * extraClaims template: any JSON; strings may contain {{user.role}}, {{user.email}}, {{user.name}}, {{user.id}},
 * {{user.phone}}, {{sub}}, {{project}}, {{provider}}. A string that is exactly one placeholder keeps the raw value.
 */
export function renderTemplateClaims(c: Ctx, p: Profile | null): Record<string, unknown> {
  if (!p) return {};
  const tpl = c.cfg.extraClaims ?? (c.preset.id === 'oidc' ? FLAVOR_CLAIMS[c.cfg.flavor ?? 'generic'] : null);
  if (!tpl || typeof tpl !== 'object') return {};
  const vars: Record<string, unknown> = {
    'user.role': p.user.role,
    'user.email': p.email,
    'user.name': p.name,
    'user.id': p.user.id,
    'user.phone': p.user.phone,
    sub: p.sub,
    project: c.project.slug,
    provider: c.provider.slug,
  };
  const render = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(v);
      if (whole) return vars[whole[1]] ?? null;
      return v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => String(vars[k] ?? ''));
    }
    if (Array.isArray(v)) return v.map(render).filter((x) => x !== null && x !== '');
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x)]));
    return v;
  };
  return render(tpl) as Record<string, unknown>;
}
