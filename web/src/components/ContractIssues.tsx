import type { ContractIssue, ContractLevel, ContractResult } from '../api';
import { Badge } from './ui';

/**
 * Readable labels for contract check ids. A static copy of CONTRACT_CHECKS in server/src/contracts/types.ts (no fetch
 * of /api/projects/:slug/contracts/checks: the list is small and fixed, and the drawer must render without a
 * project). Unknown ids show as the id itself.
 */
export const CONTRACT_CHECK_LABEL: Record<string, string> = {
  'contract.unknown-operation': 'Endpoint not in the spec',
  'contract.method-not-allowed': 'Method not in the spec',
  'contract.param': 'Parameter invalid or missing',
  'contract.unknown-param': 'Undeclared parameter',
  'contract.content-type': 'Content type not accepted',
  'contract.body-missing': 'Required body missing',
  'contract.body': 'Body does not match the schema',
  'contract.unknown-field': 'Undeclared body field',
  'contract.read-only': 'readOnly field sent',
  'contract.auth-missing': 'Credentials missing',
  'contract.deprecated': 'Deprecated operation / parameter / field used',
  'contract.response-status': 'Status not declared',
  'contract.response-body': 'Response body does not match',
  'contract.response-header': 'Response header missing / invalid',
  'contract.unchecked': 'Could not be checked',
};

export const CONTRACT_LEVEL_KIND: Record<ContractLevel, string> = { error: 'bad', warn: 'warn', info: '' };
/** Text + icon so the level never depends on colour alone. */
export const CONTRACT_LEVEL_LABEL: Record<ContractLevel, string> = { error: '✗ error', warn: '⚠ warning', info: 'ℹ info' };

const SUBJECT_LABEL: Record<ContractResult['subject'], string> = {
  'mock-request': 'Request to an API mock',
  'app-response': "Your app's response",
  'provider-request': 'Request to a provider fake',
};

/** One contract check result: header (spec, operation, mode, counts) and the issues grouped by request / response. */
export function ContractIssues({ result }: { result: ContractResult }) {
  const { counts } = result;
  const total = counts.error + counts.warn + counts.info;
  const source = result.spec ? `${result.spec.name}${result.spec.version ? ` v${result.spec.version}` : ''}` : result.provider ? `${result.provider.preset} (${result.provider.instance})` : 'No spec';
  const sides = (['request', 'response'] as const).map((side) => ({ side, issues: result.issues.filter((i) => i.side === side) })).filter((g) => g.issues.length > 0);
  return (
    <div className="stack contract-issues" style={{ gap: 8 }}>
      <div className="row contract-head">
        <span className="mono" title={result.source === 'provider' ? 'Built-in provider contract' : 'Imported OpenAPI spec'}>
          {source}
        </span>
        {result.operation && (
          <span className="mono faint">
            · {result.operation.key}
            {result.operation.operationId && ` (${result.operation.operationId})`}
          </span>
        )}
        {result.operation?.deprecated && <Badge kind="warn">deprecated</Badge>}
        <Badge title={result.mode === 'strict' ? 'Strict: issues reject the request' : 'Report: issues are logged only'}>{result.mode}</Badge>
        {result.enforced && (
          <Badge kind="bad" title="Strict mode rejected this request">
            enforced
          </Badge>
        )}
      </div>
      <div className="row small contract-counts" aria-label="Issue counts">
        <span className="muted">{SUBJECT_LABEL[result.subject] ?? result.subject}</span>
        {total === 0 ? (
          <Badge kind="ok">✓ matches the contract</Badge>
        ) : (
          (['error', 'warn', 'info'] as const)
            .filter((k) => counts[k] > 0)
            .map((k) => (
              <Badge key={k} kind={CONTRACT_LEVEL_KIND[k]}>
                {CONTRACT_LEVEL_LABEL[k].split(' ')[0]} {counts[k]} {k === 'error' ? (counts[k] === 1 ? 'error' : 'errors') : k === 'warn' ? (counts[k] === 1 ? 'warning' : 'warnings') : 'info'}
              </Badge>
            ))
        )}
      </div>
      {sides.map((g) => (
        <div key={g.side} className="table-wrap">
          <table className="contract-table">
            <caption>{g.side === 'request' ? 'Request' : 'Response'}</caption>
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Check</th>
                <th scope="col">Where</th>
                <th scope="col">Expected</th>
                <th scope="col">Actual</th>
              </tr>
            </thead>
            <tbody>
              {g.issues.map((i, n) => (
                <IssueRow key={n} issue={i} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {result.truncated && (
        <p className="small muted">
          Only the first {result.issues.length} issues are shown; the counts above include all {total}.
        </p>
      )}
    </div>
  );
}

function IssueRow({ issue: i }: { issue: ContractIssue }) {
  const where = [i.where, i.name].filter(Boolean).join(' ');
  return (
    <tr>
      <td>
        <Badge kind={CONTRACT_LEVEL_KIND[i.severity]}>{CONTRACT_LEVEL_LABEL[i.severity]}</Badge>
      </td>
      <td>
        <div>{CONTRACT_CHECK_LABEL[i.check] ?? i.check}</div>
        <div className="small muted">{i.message}</div>
      </td>
      <td className="mono small" style={{ overflowWrap: 'anywhere' }}>
        {where}
        {i.pointer && <div className="faint">{i.pointer}</div>}
      </td>
      <td className="mono small" style={{ overflowWrap: 'anywhere' }}>
        {i.expected ?? <span className="faint">—</span>}
      </td>
      <td className="mono small" style={{ overflowWrap: 'anywhere' }}>
        {i.actual ?? <span className="faint">—</span>}
      </td>
    </tr>
  );
}
