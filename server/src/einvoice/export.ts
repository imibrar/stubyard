import { registerExportSection } from '../maintenance/export.js';
import { parseFault } from './faults.js';
import { EinvoiceRepo } from './repo.js';
import { zatcaConfig, type EinvoiceRuleMatch } from './types.js';
import { createCa } from './zatca/pki.js';

/**
 * Export / import of e-invoicing instances and project-level fault rules. The fake CA key (and the production CSIDs
 * it signed) only travel with ?secrets=1; without them a new CA is generated on import and the app must re-onboard.
 * Invoices, chains, compliance CSIDs and run rules are test data.
 */
let registered = false;

export function registerEinvoiceExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'einvoiceInstances',
    table: 'einvoice_instances',
    export: ({ hub, project, includeSecrets }) =>
      new EinvoiceRepo(hub.db).listInstances(project.id).map((i) => {
        const { caKeyPem, ...config } = i.config;
        return { id: i.id, slug: i.slug, name: i.name, preset: i.preset, enabled: i.enabled, config: includeSecrets ? { ...config, caKeyPem } : config };
      }),
    import: (ctx, rows) => {
      const repo = new EinvoiceRepo(ctx.hub.db);
      let n = 0;
      for (const r of rows) {
        try {
          let config = zatcaConfig((r.config ?? {}) as Record<string, unknown>);
          const keptCa = !!(config.caKeyPem && config.caCertPem);
          if (!keptCa) {
            const ca = createCa();
            config = { ...config, caKeyPem: ca.keyPem, caCertPem: ca.certPem };
          }
          const i = repo.insertInstance({ projectId: ctx.project.id, slug: String(r.slug), name: r.name ? String(r.name) : 'ZATCA Fatoora', config, enabled: r.enabled !== false });
          if (r.id) ctx.ids.set('einvoiceInstances', String(r.id), i.id);
          if (!keptCa) ctx.warnings.push(`E-invoicing instance "${i.slug}": new fake CA generated (the CA key is only exported with secrets); onboard the EGS again (OTP, compliance CSID, production CSID).`);
          n++;
        } catch (e) {
          ctx.warnings.push(`E-invoicing instance "${String(r.slug)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });

  registerExportSection({
    key: 'einvoiceCsids',
    secret: true,
    table: 'einvoice_csids',
    export: ({ hub, project }) =>
      new EinvoiceRepo(hub.db)
        .listCsids(project.id, { kind: 'production', status: 'active' })
        .filter((c) => !c.runId)
        .map((c) => ({
          instanceId: c.instanceId, requestId: c.requestId, token: c.token, secretHash: c.secretHash, secret: c.secret, certPem: c.certPem, csrPem: c.csrPem,
          commonName: c.commonName, vatNumber: c.vatNumber, egsSerial: c.egsSerial, orgUnit: c.orgUnit, invoiceTypes: c.invoiceTypes, env: c.env, expiresAt: c.expiresAt,
        })),
    import: (ctx, rows) => {
      const repo = new EinvoiceRepo(ctx.hub.db);
      const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
      let n = 0;
      for (const r of rows) {
        const inst = ctx.ids.get('einvoiceInstances', str(r.instanceId));
        if (!inst) {
          ctx.warnings.push(`E-invoicing production CSID ${String(r.requestId)} skipped: its instance is not in the file`);
          continue;
        }
        repo.insertCsid({
          projectId: ctx.project.id, instanceId: inst, runId: null, kind: 'production', requestId: String(r.requestId), parentId: null,
          token: String(r.token), secretHash: String(r.secretHash), secret: String(r.secret), certPem: String(r.certPem), csrPem: String(r.csrPem ?? ''),
          commonName: str(r.commonName), vatNumber: str(r.vatNumber), egsSerial: str(r.egsSerial), orgUnit: str(r.orgUnit), invoiceTypes: str(r.invoiceTypes),
          env: str(r.env), expiresAt: str(r.expiresAt),
        });
        n++;
      }
      return n;
    },
  });

  registerExportSection({
    key: 'einvoiceRules',
    table: 'einvoice_rules',
    export: ({ hub, project }) =>
      new EinvoiceRepo(hub.db)
        .listRules(project.id)
        .filter((r) => !r.runId)
        .map((r) => ({ instanceId: r.instanceId, match: r.match, fault: r.fault, times: r.remaining })),
    import: (ctx, rows) => {
      const repo = new EinvoiceRepo(ctx.hub.db);
      let n = 0;
      for (const r of rows) {
        try {
          parseFault(r.fault);
          const instanceId = r.instanceId ? ctx.ids.get('einvoiceInstances', String(r.instanceId)) : null;
          if (r.instanceId && !instanceId) throw new Error('its instance is not in the file');
          const times = r.times === null || r.times === undefined ? null : Number(r.times);
          repo.insertRule({ projectId: ctx.project.id, runId: null, instanceId, match: (r.match ?? {}) as EinvoiceRuleMatch, fault: String(r.fault), remaining: times });
          n++;
        } catch (e) {
          ctx.warnings.push(`E-invoicing fault "${String(r.fault)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });
}
