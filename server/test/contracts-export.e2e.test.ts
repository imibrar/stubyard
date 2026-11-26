import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SpecRepo } from '../src/contracts/repo.js';
import { createHub } from '../src/index.js';
import { exportProject, importProject } from '../src/maintenance/export.js';

describe('project export with API specs', () => {
  let hub: ReturnType<typeof createHub>;
  let specs: SpecRepo;
  let dataDir: string;

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-contracts-export-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    specs = new SpecRepo(hub.db);
  });
  afterAll(() => {
    hub.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function seed(slug: string) {
    const project = hub.projects.create({ name: slug, slug });
    const spec = specs.create(project.id, {
      name: 'crm',
      prefix: '/crm',
      mode: 'report',
      openapiVersion: '3.1.0',
      title: 'CRM',
      apiVersion: '1.0',
      document: { openapi: '3.1.0', info: { title: 'CRM', version: '1.0' }, paths: { '/users': { get: { responses: { '200': { description: 'ok' } } } } } },
      warnings: ['w1'],
      operations: 1,
      hash: 'abc123',
    });
    const mock = hub.mocks.create(project.id, { name: 'Users', method: 'GET', path: '/crm/users', specId: spec.id, specOperation: 'GET /users', specHash: 'abc123' });
    hub.webhooks.createTemplate(project.id, { name: 'Paid', targetUrl: 'http://example.test/hook', method: 'POST', contract: { spec: 'crm', operation: 'POST /webhooks/payment' } });
    return { project, spec, mock };
  }

  it('round-trips specs, mock links (remapped) and template contracts', () => {
    const { project, spec } = seed('src1');
    const file = exportProject(hub, project);
    expect((file.apiSpecs as unknown[]).length).toBe(1);
    const keys = Object.keys(file);
    expect(keys.indexOf('apiSpecs')).toBeLessThan(keys.indexOf('mocks'));

    const res = importProject(hub, JSON.parse(JSON.stringify(file)), { slug: 'dst1' });
    expect(res.imported.apiSpecs).toBe(1);
    const copy = specs.byName(res.project.id, 'crm')!;
    expect(copy.id).not.toBe(spec.id);
    expect(copy).toMatchObject({ prefix: '/crm', mode: 'report', openapiVersion: '3.1.0', title: 'CRM', apiVersion: '1.0', warnings: ['w1'], operations: 1, hash: 'abc123' });
    expect(copy.document).toEqual(spec.document);
    const [m] = hub.mocks.list(res.project.id);
    expect(m).toMatchObject({ specId: copy.id, specOperation: 'GET /users', specHash: 'abc123' });
    expect(hub.webhooks.listTemplates(res.project.id)[0].contract).toEqual({ spec: 'crm', operation: 'POST /webhooks/payment' });

    // Replace mode clears mocks then specs and imports them again.
    const again = importProject(hub, JSON.parse(JSON.stringify(file)), { slug: 'dst1', mode: 'replace' });
    expect(specs.list(again.project.id)).toHaveLength(1);
    const copy2 = specs.byName(again.project.id, 'crm')!;
    const mocks = hub.mocks.list(again.project.id);
    expect(mocks).toHaveLength(1);
    expect(mocks[0].specId).toBe(copy2.id);
  });

  it('imports an older file without apiSpecs or link fields', () => {
    const { project } = seed('src2');
    const file = JSON.parse(JSON.stringify(exportProject(hub, project)));
    delete file.apiSpecs;
    for (const m of file.mocks) {
      delete m.specId;
      delete m.specOperation;
      delete m.specHash;
    }
    for (const t of file.webhookTemplates) delete t.contract;
    const res = importProject(hub, file, { slug: 'dst2' });
    expect(specs.list(res.project.id)).toHaveLength(0);
    expect(hub.mocks.list(res.project.id)[0]).toMatchObject({ specId: null, specOperation: null, specHash: null });
    expect(hub.webhooks.listTemplates(res.project.id)[0].contract).toBeNull();
    expect(res.warnings).toContain('The file has no "apiSpecs" section');

    // A link whose spec is not in the file is dropped.
    const orphan = JSON.parse(JSON.stringify(exportProject(hub, project)));
    delete orphan.apiSpecs;
    const r2 = importProject(hub, orphan, { slug: 'dst3' });
    expect(hub.mocks.list(r2.project.id)[0].specId).toBeNull();
  });
});
