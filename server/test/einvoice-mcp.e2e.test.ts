import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { mcpToolAccess, staleCompositeRoutes } from '../src/http/routes/mcp.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

// B6 slice S19: the e-invoicing MCP tools (einvoice/mcp-tools.ts). In-memory hub, no Mailpit.

const NEW_TOOLS = [
  'list_einvoice_instances',
  'create_einvoice_instance',
  'issue_einvoice_otp',
  'list_einvoice_csids',
  'list_einvoices',
  'get_einvoice',
  'wait_for_einvoice',
  'einvoice_lint',
  'validate_einvoice',
  'einvoice_sample',
  'set_einvoice_fault',
  'clear_einvoice_faults',
  'list_einvoice_chains',
  'reset_einvoice_chain',
  'reset_einvoices',
];

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const V2 = { 'accept-version': 'V2', 'accept-language': 'en' };

describe('e-invoicing MCP tools', () => {
  let hub: Hub;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let dataDir: string;
  let base = '';

  async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: r.status, body: parsed as T };
  }

  async function mcp(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: any }> {
    const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    expect(r.status).toBe(200);
    const res = r.body.result;
    const text = res.content[0].text as string;
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!res.isError, text, data };
  }

  /** Sends an einvoice_sample answer to the fake ZATCA like an app would (path from its endpoint URL, demo CSID). */
  const send = (s: any) =>
    api('POST', new URL(s.endpoint).pathname, { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: s.invoice }, {
      ...V2,
      'clearance-status': '0',
      authorization: `Basic ${b64(`${s.auth.binarySecurityToken}:${s.auth.secret}`)}`,
    });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-einv-mcp-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    hub?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('tools/list shows every e-invoicing tool with its annotations', async () => {
    const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = r.body.result.tools as { name: string; annotations?: Record<string, unknown> }[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of NEW_TOOLS) expect(byName.has(n), n).toBe(true);
    for (const n of ['list_einvoice_instances', 'list_einvoices', 'get_einvoice', 'wait_for_einvoice', 'einvoice_lint', 'validate_einvoice', 'list_einvoice_csids', 'list_einvoice_chains']) {
      expect(byName.get(n)!.annotations, n).toMatchObject({ readOnlyHint: true });
    }
    for (const n of ['clear_einvoice_faults', 'reset_einvoice_chain', 'reset_einvoices']) expect(byName.get(n)!.annotations, n).toMatchObject({ destructiveHint: true });
  });

  it('creates an instance, lists it and issues an OTP', async () => {
    const c = await mcp('create_einvoice_instance', { project: 'ksa', slug: 'zatca', config: { env: 'simulation' } });
    expect(c.isError, c.text).toBe(false);
    expect(c.data).toMatchObject({ slug: 'zatca', preset: 'zatca' });
    expect(c.data.urls).toBeTruthy();
    const list = await mcp('list_einvoice_instances', { project: 'ksa' });
    expect(list.data.map((i: any) => i.slug)).toEqual(['zatca']);
    const otp = await mcp('issue_einvoice_otp', { project: 'ksa', instance: 'zatca' });
    expect(otp.isError, otp.text).toBe(false);
    expect(otp.data.otp).toMatch(/^\d{6}$/);
    expect(Date.parse(otp.data.expiresAt)).toBeGreaterThan(Date.now());
    const bad = await mcp('issue_einvoice_otp', { project: 'ksa', instance: 'nope' });
    expect(bad.isError).toBe(true);
  });

  it('validates a good sample (PASS) and a broken one (its expected code)', async () => {
    const good = await mcp('einvoice_sample', { project: 'ksa' });
    expect(good.isError, good.text).toBe(false);
    expect(good.data).toMatchObject({ instance: 'zatca', type: 'simplified', breaks: [], expect: [] });
    const v = await mcp('validate_einvoice', { project: 'ksa', xml: good.data.xml, invoice_hash: good.data.invoiceHash, uuid: good.data.uuid, endpoint: 'reporting' });
    expect(v.isError, v.text).toBe(false);
    expect(v.data.status).toBe('PASS');
    expect(v.data.validationResults.errorMessages).toEqual([]);

    const broken = await mcp('einvoice_sample', { project: 'ksa', break: ['total-mismatch'] });
    expect(broken.data.expect).toEqual(['BR-CO-15']);
    const bv = await mcp('validate_einvoice', { project: 'ksa', xml: broken.data.xml, invoice_hash: broken.data.invoiceHash, uuid: broken.data.uuid });
    expect(bv.data.status).toBe('ERROR');
    expect(bv.data.findings.map((f: any) => f.code)).toContain('BR-CO-15');

    expect((await mcp('einvoice_sample', { project: 'ksa', break: ['no-such-break'] })).isError).toBe(true);
    expect((await mcp('validate_einvoice', { project: 'ksa', xml: '' })).isError).toBe(true);
  });

  it('waits for an invoice reported over the fake API; lists, gets, lints, resets its chain and the invoices', async () => {
    const s = (await mcp('einvoice_sample', { project: 'ksa', number: 'INV-MCP-1' })).data;
    const waiting = mcp('wait_for_einvoice', { project: 'ksa', number: 'INV-MCP-1', timeout: 10 });
    await new Promise((r) => setTimeout(r, 100));
    const sent = await send(s);
    expect([200, 202], JSON.stringify(sent.body)).toContain(sent.status);
    const w = await waiting;
    expect(w.isError, w.text).toBe(false);
    expect(w.data.timedOut).toBe(false);
    expect(w.data.invoices).toHaveLength(1);
    const inv = w.data.invoices[0];
    expect(inv).toMatchObject({ number: 'INV-MCP-1', endpoint: 'reporting', instance: 'zatca' });
    expect(w.data.cursor).toBe(inv.id);

    const next = await mcp('wait_for_einvoice', { project: 'ksa', after: w.data.cursor, timeout: 0 });
    expect(next.data).toMatchObject({ timedOut: true, invoices: [] });

    const list = await mcp('list_einvoices', { project: 'ksa', endpoint: 'reporting' });
    expect(list.data.map((i: any) => i.id)).toEqual([inv.id]);
    const one = await mcp('get_einvoice', { project: 'ksa', id: inv.id });
    expect(one.data.xml).toContain('INV-MCP-1');
    expect(one.data.chain?.id).toBeTruthy();

    const lint = await mcp('einvoice_lint', { project: 'ksa' });
    expect(lint.isError, lint.text).toBe(false);
    expect(lint.data.invoices).toBe(1);

    const csids = await mcp('list_einvoice_csids', { project: 'ksa', kind: 'demo' });
    expect(csids.data).toHaveLength(1);
    expect(csids.data[0].secretHash).toBeUndefined();

    const chains = await mcp('list_einvoice_chains', { project: 'ksa' });
    expect(chains.data.map((c: any) => c.id)).toEqual([one.data.chain.id]);
    expect(chains.data[0].next.icv).toBe(2);
    const reset = await mcp('reset_einvoice_chain', { project: 'ksa', chain: one.data.chain.id });
    expect(reset.isError, reset.text).toBe(false);
    expect(reset.data.next.icv).toBe(1);

    const del = await mcp('reset_einvoices', { project: 'ksa' });
    expect(del.data).toEqual({ deleted: 1 });
    expect((await mcp('list_einvoices', { project: 'ksa' })).data).toEqual([]);
  });

  it('sets a fault the fake ZATCA answers with, then clears it', async () => {
    const f = await mcp('set_einvoice_fault', { project: 'ksa', fault: 'server_error', endpoint: 'reporting', times: 1 });
    expect(f.isError, f.text).toBe(false);
    expect(f.data).toMatchObject({ fault: 'server_error', remaining: 1, match: { endpoint: 'reporting' } });
    expect((await api('GET', '/api/projects/ksa/einvoice/faults')).body).toHaveLength(1);
    const s = (await mcp('einvoice_sample', { project: 'ksa', number: 'INV-MCP-F' })).data;
    expect((await send(s)).status).toBe(500);

    expect((await mcp('set_einvoice_fault', { project: 'ksa', fault: 'nonsense' })).isError).toBe(true);
    await mcp('set_einvoice_fault', { project: 'ksa', fault: 'reject' });
    const cleared = await mcp('clear_einvoice_faults', { project: 'ksa' });
    expect(cleared.data.deleted).toBe(2);
    expect((await api('GET', '/api/projects/ksa/einvoice/faults')).body).toEqual([]);
    const ok = await send((await mcp('einvoice_sample', { project: 'ksa', number: 'INV-MCP-G' })).data);
    expect([200, 202]).toContain(ok.status);
  });

  it('access: every new tool is mapped from its route; no stale composite lines', () => {
    const access = mcpToolAccess(app);
    const perm = (n: string) => (access.get(n) as { permission: string } | null)?.permission;
    for (const n of NEW_TOOLS) expect(perm(n), n).toBeTruthy();
    for (const n of ['list_einvoice_instances', 'list_einvoices', 'get_einvoice', 'wait_for_einvoice', 'einvoice_lint', 'validate_einvoice', 'list_einvoice_csids', 'list_einvoice_chains']) expect(perm(n), n).toBe('project.view');
    for (const n of ['create_einvoice_instance', 'issue_einvoice_otp', 'set_einvoice_fault', 'clear_einvoice_faults']) expect(perm(n), n).toBe('project.providers');
    for (const n of ['einvoice_sample', 'reset_einvoice_chain', 'reset_einvoices']) expect(perm(n), n).toBe('walkthroughs.run');
    expect(staleCompositeRoutes()).toEqual([]);
  });
});
