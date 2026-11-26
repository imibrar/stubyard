import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { EinvoiceRepo } from '../src/einvoice/repo.js';
import { EinvoiceService } from '../src/einvoice/service.js';
import type { EinvoiceInstance } from '../src/einvoice/types.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { exportProject, importProject } from '../src/maintenance/export.js';
import type { Project } from '../src/repos/projects.js';

let hub: Hub;
let repo: EinvoiceRepo;
let project: Project;
let inst: EinvoiceInstance;
let dataDir: string;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-einv-export-'));
  const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
  hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
  repo = new EinvoiceRepo(hub.db);
  const svc = new EinvoiceService({ db: hub.db, timeoutHoldMs: 200 });
  project = hub.projects.create({ name: 'Einv Export' });
  inst = svc.createInstance(project, { slug: 'zatca', config: { checks: 'basic', otp: '123456' } });
  repo.insertRule({ projectId: project.id, runId: null, instanceId: inst.id, match: { endpoint: 'reporting' }, fault: 'reject', remaining: 2 });
  repo.insertCsid({
    projectId: project.id, instanceId: inst.id, runId: null, kind: 'production', requestId: '1234567890123', parentId: null, token: 'tok', secretHash: 'h',
    secret: 'shh', certPem: 'cert', csrPem: 'csr', commonName: 'cn', vatNumber: '300000000000003', egsSerial: null, orgUnit: null, invoiceTypes: '1100', env: null, expiresAt: null,
  });
});

afterAll(() => {
  hub.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('einvoice export / import', () => {
  it('without secrets: no CA key, no CSIDs; import regenerates the CA with a warning', () => {
    const file = exportProject(hub, project);
    const rows = file.einvoiceInstances as { config: Record<string, unknown> }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].config.caKeyPem).toBeUndefined();
    expect(rows[0].config.caCertPem).toBe(inst.config.caCertPem);
    expect(file.einvoiceCsids).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain('PRIVATE KEY');

    const res = importProject(hub, file, { slug: 'einv-copy-1' });
    const got = repo.listInstances(res.project.id);
    expect(got).toHaveLength(1);
    expect(got[0].config.otp).toBe('123456');
    expect(got[0].config.caKeyPem).toContain('PRIVATE KEY');
    expect(got[0].config.caCertPem).not.toBe(inst.config.caCertPem);
    expect(res.warnings.some((w) => w.includes('new fake CA'))).toBe(true);
    const rules = repo.listRules(res.project.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ instanceId: got[0].id, fault: 'reject', remaining: 2, match: { endpoint: 'reporting' } });
  });

  it('with secrets: keeps the CA and the production CSIDs', () => {
    const file = exportProject(hub, project, { includeSecrets: true });
    const res = importProject(hub, file, { slug: 'einv-copy-2' });
    const got = repo.listInstances(res.project.id);
    expect(got[0].config.caCertPem).toBe(inst.config.caCertPem);
    expect(got[0].config.caKeyPem).toBe(inst.config.caKeyPem);
    expect(res.warnings.some((w) => w.includes('new fake CA'))).toBe(false);
    const csids = repo.listCsids(res.project.id);
    expect(csids).toHaveLength(1);
    expect(csids[0]).toMatchObject({ instanceId: got[0].id, kind: 'production', token: 'tok', secret: 'shh' });
  });

  it('an older export without the einvoice sections still imports', () => {
    const file = exportProject(hub, project) as Record<string, unknown>;
    delete file.einvoiceInstances;
    delete file.einvoiceRules;
    const res = importProject(hub, file, { slug: 'einv-copy-3' });
    expect(repo.listInstances(res.project.id)).toHaveLength(0);
  });
});
