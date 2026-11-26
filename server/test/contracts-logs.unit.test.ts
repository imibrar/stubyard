import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/index.js';
import { LogRepo } from '../src/repos/logs.js';
import { ProjectRepo } from '../src/repos/projects.js';
import {
  CONTRACT_CHECKS, checkLabel, countIssues, levelOf, type ContractIssue, type ContractResult,
} from '../src/contracts/types.js';

let db: DB;
let logs: LogRepo;
let projectId: string;

beforeEach(() => {
  db = openDb(':memory:');
  logs = new LogRepo(db);
  projectId = new ProjectRepo(db).create({ name: 'Hyper' }).id;
});

const issue = (check: ContractIssue['check'], severity: ContractIssue['severity']): ContractIssue => ({
  check, severity, side: 'request', where: 'body', message: `${check} failed`,
});

function result(issues: ContractIssue[]): ContractResult {
  return {
    v: 1, subject: 'mock-request', source: 'spec',
    spec: { id: 'spec1', name: 'petstore', version: '1.0.0' }, provider: null,
    operation: { key: 'GET /pets/{id}', operationId: 'getPet', deprecated: false },
    mode: 'report', enforced: false, level: levelOf(issues), counts: countIssues(issues), issues,
  };
}

function logWith(issues: ContractIssue[] | null): string {
  const id = logs.start({ projectId, direction: 'inbound', protocol: 'http', method: 'GET', url: '/mock/hyper/api/pets/1' });
  if (issues) {
    const c = result(issues);
    logs.update(id, { contract: c, contractLevel: c.level });
  }
  return id;
}

describe('contract helpers', () => {
  it('computes level, counts and labels', () => {
    expect(levelOf([])).toBeNull();
    expect(levelOf([issue('contract.unchecked', 'info'), issue('contract.unknown-field', 'warn')])).toBe('warn');
    expect(levelOf([issue('contract.unknown-field', 'warn'), issue('contract.body', 'error')])).toBe('error');
    expect(countIssues([issue('contract.body', 'error'), issue('contract.param', 'error'), issue('contract.unchecked', 'info')]))
      .toEqual({ error: 2, warn: 0, info: 1 });
    expect(checkLabel('contract.body')).toBe('Body does not match the schema');
    expect(checkLabel('contract.nope')).toBe('contract.nope');
    expect(new Set(CONTRACT_CHECKS.map((c) => c.id)).size).toBe(CONTRACT_CHECKS.length);
  });
});

describe('traffic log contract fields', () => {
  it('defaults to unchecked', () => {
    const id = logWith(null);
    const full = logs.get(id)!;
    expect(full.contract).toBeNull();
    expect(full.contractLevel).toBeNull();
    const [summary] = logs.list({ projectId });
    expect(summary.contractLevel).toBeNull();
    expect(summary.contractIssues).toBe(0);
    expect('contract' in summary).toBe(false);
  });

  it('stores the result and exposes level + issue count in summaries', () => {
    const issues = [issue('contract.body', 'error'), issue('contract.unknown-field', 'warn')];
    const id = logWith(issues);
    const full = logs.get(id)!;
    expect(full.contract).toEqual(result(issues));
    expect(full.contractLevel).toBe('error');
    const [summary] = logs.list({ projectId });
    expect(summary).toMatchObject({ id, contractLevel: 'error', contractIssues: 2 });
    expect('contract' in summary).toBe(false);
    expect(summary).not.toHaveProperty('reqBody');

    logs.update(id, { contract: null, contractLevel: null });
    expect(logs.get(id)).toMatchObject({ contract: null, contractLevel: null });
  });

  it('filters by contract state', () => {
    const none = logWith(null);
    const clean = logWith([]);
    const info = logWith([issue('contract.unchecked', 'info')]);
    const warn = logWith([issue('contract.unknown-param', 'warn')]);
    const error = logWith([issue('contract.param', 'error'), issue('contract.deprecated', 'warn')]);
    const ids = (contract: 'checked' | 'issues' | 'error' | 'warn') => logs.list({ projectId, contract }).map((l) => l.id).sort();

    expect(ids('checked')).toEqual([clean, info, warn, error].sort());
    expect(ids('issues')).toEqual([warn, error].sort());
    expect(ids('warn')).toEqual([warn, error].sort());
    expect(ids('error')).toEqual([error]);
    expect(logs.list({ projectId }).map((l) => l.id)).toContain(none);
    expect(logs.list({ projectId, contract: 'error' })[0].contractIssues).toBe(2);
  });
});
