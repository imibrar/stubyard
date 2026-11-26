import { beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt, verifyJwt } from '../src/auth/jwt.js';
import { openDb, type DB } from '../src/db/index.js';
import { jwks, nafathClaims, personClaims } from '../src/nafath/claims.js';
import { appliesTo, parseFault } from '../src/nafath/faults.js';
import { isNationalId } from '../src/nafath/national-id.js';
import { NafathService } from '../src/nafath/service.js';
import { NafathError, nafathConfig, type NafathInstance, type NafathRequest } from '../src/nafath/types.js';
import { ProjectRepo, type Project } from '../src/repos/projects.js';
import { RunRepo } from '../src/repos/runs.js';
import { UserRepo } from '../src/repos/users.js';

let db: DB;
let users: UserRepo;
let project: Project;
let svc: NafathService;
let clock: number;
let events: unknown[];

beforeEach(() => {
  db = openDb(':memory:');
  users = new UserRepo(db);
  project = new ProjectRepo(db).create({ name: 'Nafath App' });
  clock = Date.parse('2026-11-26T10:00:00Z');
  events = [];
  svc = new NafathService({ db, users, now: () => clock, publish: (_p, d) => events.push(d) });
});

const creds = (i: NafathInstance) => ({ appId: i.appId, appKey: i.appKey });

/** Verify a token against the instance's JWK set by kid. */
function verifies(inst: NafathInstance, token: string): boolean {
  const kid = decodeJwt(token)?.header.kid;
  const jwk = jwks(inst).keys.find((k) => k.kid === kid);
  return !!jwk && !!verifyJwt(token, jwk);
}

function catchNafath(fn: () => unknown): NafathError {
  try {
    fn();
  } catch (e) {
    if (e instanceof NafathError) return e;
    throw e;
  }
  throw new Error('expected a NafathError');
}

describe('instances', () => {
  it('creates APP-ID / APP-KEY and a signing key, and fills national IDs on the first instance', () => {
    const a = users.create(project.id, { name: 'Ali', role: 'customer' });
    expect(a.nationalId).toBeNull();
    const inst = svc.createInstance(project);
    expect(inst.slug).toBe('nafath');
    expect(inst.appId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inst.appKey).toMatch(/^[0-9a-f]{32}$/);
    expect(inst.keys).toHaveLength(1);
    expect(inst.keys[0]).toMatchObject({ status: 'active' });
    expect(inst.config).toMatchObject({ ttlSeconds: 200, autoDecision: 'none', autoDelayMs: 3000, callbackFields: 'default' });
    expect(isNationalId(users.get(project.id, a.id)!.nationalId)).toBe(true);
    expect(svc.createInstance(project).slug).toBe('nafath-2');
    expect(() => svc.createInstance(project, { appId: inst.appId })).toThrow(/already used/);
    expect(svc.viewInstance(inst).keys[0]).not.toHaveProperty('privatePem');
  });

  it('normalises config and rejects bad values', () => {
    const c = nafathConfig({ ttlSeconds: 60, services: 'Login, Pay', callbackUrl: 'https://app.test/cb' }, null);
    expect(c).toMatchObject({ ttlSeconds: 60, services: ['Login', 'Pay'], callbackUrl: 'https://app.test/cb', autoDecision: 'none' });
    expect(nafathConfig({ autoDecision: 'approve' }, c)).toMatchObject({ ttlSeconds: 60, autoDecision: 'approve' });
    expect(() => nafathConfig({ ttlSeconds: 0 }, null)).toThrow(/ttlSeconds/);
    expect(() => nafathConfig({ autoDecision: 'maybe' }, null)).toThrow(/autoDecision/);
    expect(() => nafathConfig({ callbackUrl: 'ftp://x' }, null)).toThrow(/http/);
    expect(() => nafathConfig({ callbackFields: 'x' }, null)).toThrow(/callbackFields/);
  });

  it('rotates keys: the retired key stays in the JWK set until dropOld', () => {
    const inst = svc.createInstance(project);
    const u = users.create(project.id, { name: 'Ali', nationalId: '1000000008' });
    const r1 = svc.startRequest(inst, { nationalId: u.nationalId, service: 'Login', ...creds(inst) });
    const t1 = svc.approve(r1.request).token!;
    const rotated = svc.rotateKeys(project, inst.slug);
    expect(rotated.keys.map((k) => k.status)).toEqual(['retired', 'active']);
    expect(jwks(rotated).keys).toHaveLength(2);
    expect(verifies(rotated, t1)).toBe(true);
    const r2 = svc.startRequest(rotated, { nationalId: u.nationalId, service: 'Login', ...creds(inst) });
    const t2 = svc.approve(r2.request).token!;
    expect(decodeJwt(t2)!.header.kid).toBe(rotated.keys[1].kid);
    const dropped = svc.rotateKeys(project, inst.slug, { dropOld: true });
    expect(dropped.keys).toHaveLength(1);
    expect(verifies(dropped, t1)).toBe(false);
  });
});

describe('requests', () => {
  let inst: NafathInstance;
  let citizenId: string;
  beforeEach(() => {
    users.create(project.id, { name: 'Ali Hassan', role: 'customer', nationalId: '1000000008' });
    users.create(project.id, { name: 'Sara (Customer 2)', role: 'customer', nationalId: '2000000006' });
    inst = svc.createInstance(project);
    citizenId = '1000000008';
  });

  it('starts WAITING with three distinct choices that contain random; a second request is 400-034-050', () => {
    const r = svc.startRequest(inst, { nationalId: citizenId, service: 'Login', requestId: 'req-1', ...creds(inst) });
    expect(r.transId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.random).toMatch(/^\d{2}$/);
    expect(r.request.status).toBe('WAITING');
    expect(new Set(r.request.choices).size).toBe(3);
    expect(r.request.choices).toContain(r.random);
    expect(r.request.testUserId).not.toBeNull();
    expect(r.warnings).toEqual([]);
    expect(Date.parse(r.request.expiresAt) - clock).toBe(200_000);
    const e = catchNafath(() => svc.startRequest(inst, { nationalId: citizenId, service: 'Login', ...creds(inst) }));
    expect(e).toMatchObject({ status: 400, code: '400-034-050' });
    expect(svc.status(inst, { nationalId: citizenId, transId: r.transId, random: r.random }).status).toBe('WAITING');
    expect(svc.repo.getRequest(r.request.id)!.polls).toBe(1);
  });

  it('the right number completes with a token that verifies against the JWK set', () => {
    const r = svc.startRequest(inst, { nationalId: citizenId, service: 'Login', requestId: 'req-1', ...creds(inst) });
    const done = svc.choose(r.request, r.random);
    expect(done).toMatchObject({ status: 'COMPLETED', chosen: r.random, decidedBy: 'person' });
    expect(verifies(inst, done.token!)).toBe(true);
    const t = decodeJwt(done.token!)!;
    expect(t.header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: inst.keys[0].kid });
    expect(t.payload).toMatchObject({ aud: inst.appId, status: 'COMPLETED', transId: r.transId, requestId: 'req-1', service: 'Login', nin: citizenId });
    expect(svc.status(inst, { nationalId: citizenId, transId: r.transId, random: r.random }).status).toBe('COMPLETED');
    const info = svc.info(inst, { nationalId: citizenId, transId: r.transId, random: r.random });
    expect(info.person).toMatchObject({ nin: citizenId, englishFirstName: 'Ali', englishLastName: 'Hassan' });
    expect(() => svc.approve(done)).toThrow(/already COMPLETED/);
    expect(events.length).toBeGreaterThan(0);
  });

  it('a wrong number rejects with reason wrong_number and a REJECTED token without person claims', () => {
    const r = svc.startRequest(inst, { nationalId: citizenId, service: 'Login', ...creds(inst) });
    const wrong = r.request.choices.find((c) => c !== r.random)!;
    const done = svc.choose(r.request, wrong);
    expect(done).toMatchObject({ status: 'REJECTED', reason: 'wrong_number', chosen: wrong });
    const p = decodeJwt(done.token!)!.payload;
    expect(p.status).toBe('REJECTED');
    expect(p).not.toHaveProperty('nin');
    expect(catchNafath(() => svc.info(inst, { nationalId: citizenId, transId: r.transId, random: r.random })).status).toBe(400);
  });

  it('expires lazily after the TTL on the injected clock, and a new request can start', () => {
    const r = svc.startRequest(inst, { nationalId: citizenId, service: 'Login', ...creds(inst) });
    clock += 199_000;
    expect(svc.status(inst, { nationalId: citizenId, transId: r.transId, random: r.random }).status).toBe('WAITING');
    clock += 1_000;
    const s = svc.status(inst, { nationalId: citizenId, transId: r.transId, random: r.random });
    expect(s.status).toBe('EXPIRED');
    expect(svc.repo.getRequest(r.request.id)).toMatchObject({ status: 'EXPIRED', reason: 'expired', token: null });
    expect(catchNafath(() => svc.info(inst, { nationalId: citizenId, transId: r.transId, random: r.random })).code).toBe('400-034-051');
    expect(svc.startRequest(inst, { nationalId: citizenId, service: 'Login', ...creds(inst) }).request.status).toBe('WAITING');
  });

  it('strict: wrong credentials are 403, unknown IDs 400-034-053; lax warns and records an unassigned request', () => {
    const strict = svc.updateInstance(project, inst.slug, { strict: true });
    expect(catchNafath(() => svc.startRequest(strict, { nationalId: citizenId, service: 'Login', appId: strict.appId, appKey: 'nope' })).status).toBe(403);
    expect(catchNafath(() => svc.startRequest(strict, { nationalId: '1234567897', service: 'Login', ...creds(strict) })).code).toBe('400-034-053');
    const lax = svc.updateInstance(project, inst.slug, { strict: false });
    const r = svc.startRequest(lax, { nationalId: '1234567897', service: 'Login', appId: 'x', appKey: 'y', strictHeadersWarnings: ['No X-Forwarded-For header'] });
    expect(r.request.testUserId).toBeNull();
    expect(r.warnings).toEqual(expect.arrayContaining(['No X-Forwarded-For header', expect.stringMatching(/APP-ID/), expect.stringMatching(/unassigned/)]));
    expect(svc.listRequests(project.id, { unassigned: true }).map((q) => q.id)).toEqual([r.request.id]);
  });

  it('strict checks the services allowlist', () => {
    const strict = svc.updateInstance(project, inst.slug, { strict: true, config: { services: ['Login'] } });
    expect(catchNafath(() => svc.startRequest(strict, { nationalId: citizenId, service: 'Pay', ...creds(strict) })).status).toBe(400);
    expect(svc.startRequest(strict, { nationalId: citizenId, service: 'Login', ...creds(strict) }).request.status).toBe('WAITING');
  });

  it('statusLagMs keeps /status WAITING for a while after the decision', () => {
    const lagged = svc.updateInstance(project, inst.slug, { config: { statusLagMs: 5000 } });
    const r = svc.startRequest(lagged, { nationalId: citizenId, service: 'Login', ...creds(lagged) });
    svc.approve(r.request);
    expect(svc.status(lagged, { nationalId: citizenId, transId: r.transId, random: r.random }).status).toBe('WAITING');
    clock += 5000;
    expect(svc.status(lagged, { nationalId: citizenId, transId: r.transId, random: r.random }).status).toBe('COMPLETED');
  });

  it('autoDecision with no delay decides at once', () => {
    const auto = svc.updateInstance(project, inst.slug, { config: { autoDecision: 'approve', autoDelayMs: 0 } });
    expect(svc.startRequest(auto, { nationalId: citizenId, service: 'Login', ...creds(auto) }).request).toMatchObject({ status: 'COMPLETED', decidedBy: 'auto' });
  });
});

describe('fault rules', () => {
  let inst: NafathInstance;
  const id = '1000000008';
  const start = () => svc.startRequest(inst, { nationalId: id, service: 'Login', ...creds(inst) });
  beforeEach(() => {
    users.create(project.id, { name: 'Ali', nationalId: id });
    inst = svc.createInstance(project);
  });

  it('parses faults and knows their stages', () => {
    expect(parseFault('slow:500')).toMatchObject({ kind: 'slow', arg: 500 });
    expect(parseFault('approve')).toMatchObject({ kind: 'approve', arg: null });
    expect(() => parseFault('slow')).toThrow(/delay/);
    expect(() => parseFault('down:5')).toThrow(/no argument/);
    expect(() => parseFault('nope')).toThrow(/Unknown/);
    expect(appliesTo('bad_signature', 'decide')).toBe(true);
    expect(appliesTo('bad_signature', 'request')).toBe(false);
    expect(appliesTo('down', 'status')).toBe(true);
    expect(appliesTo('no_callback', 'callback')).toBe(true);
  });

  it('rejected / expired decide at once; times limits a rule', () => {
    svc.addFault(project, { fault: 'rejected', user: 'Ali', times: 1 });
    const r = start();
    expect(r.request).toMatchObject({ status: 'REJECTED', reason: 'rejected' });
    expect(r.request.decidedBy).toMatch(/^rule:/);
    expect(start().request.status).toBe('WAITING');
    svc.resetRequests(project);
    svc.addFault(project, { fault: 'expired', nationalId: id });
    expect(start().request).toMatchObject({ status: 'EXPIRED', token: null });
  });

  it('already_active answers 400-034-050 with nothing waiting', () => {
    svc.addFault(project, { fault: 'already_active', times: 1 });
    expect(catchNafath(start).code).toBe('400-034-050');
    expect(start().request.status).toBe('WAITING');
  });

  it('down / rate_limit / timeout / slow at the request stage', () => {
    svc.addFault(project, { fault: 'down', times: 1 });
    expect(catchNafath(start).status).toBe(503);
    svc.addFault(project, { fault: 'rate_limit', times: 1 });
    expect(catchNafath(start).status).toBe(429);
    svc.addFault(project, { fault: 'timeout', times: 1 });
    expect(catchNafath(start).hold).toBe(true);
    svc.addFault(project, { fault: 'slow:250', times: 1 });
    expect(start().delayMs).toBe(250);
  });

  it('bad_signature and unknown_kid break the token, and rules are consumed only at their stage', () => {
    svc.addFault(project, { fault: 'bad_signature', times: 1 });
    const bad = svc.approve(start().request).token!;
    expect(decodeJwt(bad)!.header.kid).toBe(inst.keys[0].kid);
    expect(verifies(inst, bad)).toBe(false);

    svc.addFault(project, { fault: 'unknown_kid', times: 1 });
    const unknown = svc.approve(start().request).token!;
    const kid = decodeJwt(unknown)!.header.kid;
    expect(kid).not.toBe(inst.keys[0].kid);
    expect(jwks(inst).keys.some((k) => k.kid === kid)).toBe(false);

    expect(verifies(inst, svc.approve(start().request).token!)).toBe(true);

    // The decision faults are not consumed at the decide stage, and the bad_signature rule only there.
    svc.addFault(project, { fault: 'wrong_number' });
    const ordered = svc.listFaults(project.id);
    expect(ordered.map((r) => r.fault)).toEqual(['bad_signature', 'unknown_kid', 'wrong_number']);
    expect(ordered.map((r) => r.remaining)).toEqual([0, 0, null]);
    expect(start().request).toMatchObject({ status: 'REJECTED', reason: 'wrong_number' });
    expect(svc.addFault(project, { fault: 'none' })).toBeNull();
    expect(svc.listFaults(project.id)).toEqual([]);
  });

  it('matches a run rule before a project rule', () => {
    const run = new RunRepo(db).create(project.id, { key: 'k', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    svc.addFault(project, { fault: 'rejected' });
    svc.addFault(project, { fault: 'approve' }, run.id);
    expect(svc.startRequest(inst, { nationalId: id, service: 'Login', runId: run.id, ...creds(inst) }).request.status).toBe('COMPLETED');
    svc.resetRequests(project);
    expect(start().request.status).toBe('REJECTED');
  });
});

describe('claims', () => {
  const req = (over: Partial<NafathRequest> = {}) => ({ status: 'COMPLETED', transId: 't', requestId: null, service: 'Login', ...over }) as NafathRequest;

  it('a citizen gets nin, a resident iqamaNumber; identity overrides the derived defaults', () => {
    const cit = users.create(project.id, { name: 'Ali (Customer 1)', nationalId: '1000000008' });
    const res = users.create(project.id, { name: 'Sara Khan', nationalId: '2000000006', identity: { firstNameAr: 'سارة', nationalityCode: 'PK', dateOfBirthG: '01-02-1990', gender: 'F' } });
    const c = personClaims(cit, cit.nationalId!);
    expect(c).toMatchObject({ nin: '1000000008', englishFirstName: 'Ali', firstName: 'علي', nationalityCode: 'SA', nationality: 'Saudi Arabia', gender: 'M', isMinor: false });
    expect(c).not.toHaveProperty('iqamaNumber');
    expect(c.dateOfBirthG).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    expect(c.idExpiryDateG).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    expect(personClaims(cit, cit.nationalId!)).toEqual(c); // deterministic
    const r = personClaims(res, res.nationalId!);
    expect(r).toMatchObject({ iqamaNumber: '2000000006', firstName: 'سارة', englishLastName: 'Khan', nationalityCode: 'PK', nationality: 'Pakistan', dateOfBirthG: '01-02-1990', gender: 'F' });
    expect(r).not.toHaveProperty('nin');
    expect(personClaims(null, '1234567897')).toMatchObject({ nin: '1234567897', englishFirstName: 'Test' });
  });

  it('REJECTED carries no person claims', () => {
    const inst = svc.createInstance(project);
    expect(nafathClaims(null, '1000000008', req({ status: 'REJECTED' }), inst)).not.toHaveProperty('nin');
    expect(nafathClaims(null, '1000000008', req(), inst)).toMatchObject({ aud: inst.appId, status: 'COMPLETED', nin: '1000000008' });
  });
});
