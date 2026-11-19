import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/index.js';
import { MessageRepo } from '../src/repos/messages.js';
import { ProjectRepo } from '../src/repos/projects.js';
import { ProviderRepo } from '../src/repos/providers.js';
import { UserRepo } from '../src/repos/users.js';

let db: DB;
let projects: ProjectRepo;
let users: UserRepo;
let providers: ProviderRepo;

beforeEach(() => {
  db = openDb(':memory:');
  projects = new ProjectRepo(db);
  users = new UserRepo(db);
  providers = new ProviderRepo(db);
});

describe('projects', () => {
  it('derives a slug and rejects duplicates', () => {
    const p = projects.create({ name: 'Hyper App' });
    expect(p.slug).toBe('hyper-app');
    expect(() => projects.create({ name: 'Other', slug: 'hyper-app' })).toThrow(/already exists/);
    expect(() => projects.create({ name: 'Bad', slug: 'Bad Slug' })).toThrow(/Slug/);
  });

  it('cascades deletes to users, providers and messages', () => {
    const p = projects.create({ name: 'Hyper' });
    users.create(p.id, { name: 'A', email: 'a@x.test' });
    providers.create(p.id, { preset: 'smtp', slug: 'mail' });
    new MessageRepo(db).insert({
      projectId: p.id, testUserId: null, providerInstanceId: null, channel: 'email', direction: 'outbound',
      from: null, to: 'a@x.test', subject: 's', bodyText: 'b', hasHtml: false, attachments: 0, mailpitId: null,
      messageIdHeader: null, status: 'delivered', otp: null, links: [], logId: null,
    });
    projects.delete('hyper');
    const counts = db.prepare('SELECT (SELECT COUNT(*) FROM test_users) u, (SELECT COUNT(*) FROM provider_instances) p, (SELECT COUNT(*) FROM messages) m').get();
    expect(counts).toEqual({ u: 0, p: 0, m: 0 });
  });
});

describe('test users', () => {
  it('normalizes addresses and enforces uniqueness within a project only', () => {
    const a = projects.create({ name: 'A' });
    const b = projects.create({ name: 'B' });
    const u = users.create(a.id, { name: 'Ali', email: ' Ali@X.test ', phone: '0092 300-123 4567' });
    expect(u.email).toBe('ali@x.test');
    expect(u.phone).toBe('+923001234567');
    expect(u.whatsapp).toBe('+923001234567');
    expect(() => users.create(a.id, { name: 'Dup', email: 'ali@x.test' })).toThrow(/already used/);
    expect(() => users.create(b.id, { name: 'Same in B', email: 'ali@x.test' })).not.toThrow();
    expect(users.findByPhone(a.id, 'whatsapp:+92 300 1234567', 'whatsapp')?.id).toBe(u.id);
  });

  it('generates 1 admin + 9 customers with unique details', () => {
    const p = projects.create({ name: 'Hyper' });
    const created = users.generate(p.id, { admins: 1, customers: 9, emailDomain: 'hyper.test', phonePrefix: '+92300' });
    expect(created).toHaveLength(10);
    expect(created[0]).toMatchObject({ role: 'admin', email: 'admin@hyper.test', phone: '+923000000001' });
    expect(new Set(created.map((u) => u.phone)).size).toBe(10);
    // Generating again continues without collisions.
    const more = users.generate(p.id, { admins: 0, customers: 2, emailDomain: 'hyper.test', phonePrefix: '+92300' });
    expect(more.map((u) => u.email)).toEqual(['customer10@hyper.test', 'customer11@hyper.test']);
    expect(more[0].name).toContain('Customer 10');
    expect(users.list(p.id)).toHaveLength(12);
  });

  it('generates users for any roles, auto-pins one per role and resolves references', () => {
    const p = projects.create({ name: 'Shop' });
    const created = users.generate(p.id, {
      roles: [{ role: 'Admin', count: 1 }, { role: 'sales', count: 2 }, { role: 'support', count: 1 }, { role: 'customer', count: 3 }, { role: 'driver', count: 1 }],
      emailDomain: 'shop.test',
      phonePrefix: '+1555',
      password: 'Secret1!',
    });
    expect(created.map((u) => u.name)).toEqual(['Admin', 'Sales 1', 'Sales 2', 'Support', 'Ali (Customer 1)', 'Sara (Customer 2)', 'Omar (Customer 3)', 'Driver']);
    expect(created.map((u) => u.email)).toContain('sales2@shop.test');
    expect(created[0].password).toBe('Secret1!');
    // First of each role pinned, max 4.
    const pinned = users.list(p.id).filter((u) => u.pinned > 0);
    expect(pinned.map((u) => u.name)).toEqual(['Admin', 'Sales 1', 'Support', 'Ali (Customer 1)']);

    expect(users.resolve(p.id, 'admin')?.name).toBe('Admin');
    expect(users.resolve(p.id, 'sales')?.name).toBe('Sales 1');
    expect(users.resolve(p.id, 'Sales 2')?.email).toBe('sales2@shop.test');
    expect(users.resolve(p.id, 'SALES2@shop.test')?.name).toBe('Sales 2');
    expect(users.resolve(p.id, created[1].phone!)?.name).toBe('Sales 1');
    expect(users.resolve(p.id, 'customer3')?.name).toBe('Omar (Customer 3)');
    expect(users.resolve(p.id, 'nobody')).toBeNull();

    // Unpin keeps positions contiguous; reorder sets the bar exactly.
    users.setPinned(p.id, pinned[1].id, false);
    expect(users.list(p.id).filter((u) => u.pinned > 0).map((u) => [u.name, u.pinned])).toEqual([['Admin', 1], ['Support', 2], ['Ali (Customer 1)', 3]]);
    users.reorderPins(p.id, [created[7].id, created[0].id]);
    expect(users.list(p.id).filter((u) => u.pinned > 0).map((u) => u.name)).toEqual(['Driver', 'Admin']);
    expect(users.update(p.id, created[2].id, { pinned: true }).pinned).toBe(3);
  });
});

describe('provider instances', () => {
  it('allows several instances per channel and keeps exactly one default', () => {
    const p = projects.create({ name: 'Hyper' });
    const primary = providers.create(p.id, { preset: 'twilio', slug: 'sms-primary', labels: ['Primary', 'transactional'] });
    const fallback = providers.create(p.id, { preset: 'vonage', slug: 'sms-fallback', labels: ['fallback'] });
    const twilio2 = providers.create(p.id, { preset: 'twilio', slug: 'sms-marketing' });
    expect(primary.isDefault).toBe(true);
    expect(primary.labels).toEqual(['primary', 'transactional']);
    expect(fallback.isDefault).toBe(false);
    expect(twilio2.preset).toBe('twilio');

    providers.update(p.id, 'sms-fallback', { isDefault: true });
    expect(providers.defaultFor(p.id, 'sms')?.slug).toBe('sms-fallback');
    expect(providers.list(p.id).filter((i) => i.isDefault)).toHaveLength(1);

    providers.delete(p.id, 'sms-fallback');
    expect(providers.defaultFor(p.id, 'sms')?.isDefault).toBe(true);
  });

  it('rejects unknown presets and cross-channel preset changes', () => {
    const p = projects.create({ name: 'Hyper' });
    expect(() => providers.create(p.id, { preset: 'nope' })).toThrow(/Unknown provider preset/);
    providers.create(p.id, { preset: 'smtp', slug: 'mail' });
    expect(() => providers.update(p.id, 'mail', { preset: 'twilio' })).toThrow(/same channel/);
  });
});
