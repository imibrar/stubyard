// CA trust check (dashboard): can this browser load stubyard over HTTPS without a certificate error? A no-cors fetch
// of https://<host>:<https port>/api/system resolves (opaque) when the certificate is trusted and rejects when the
// browser refuses it (or the port is not reachable). Nothing is read from the answer.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SystemInfo } from '../api';

export type CaTrustState = 'checking' | 'trusted' | 'untrusted' | 'off';

/** The HTTPS URL the browser uses for stubyard: this page when it is https, else this host on the HTTPS port. */
export function httpsBaseOf(sys: Pick<SystemInfo, 'ports'>, loc: { protocol: string; hostname: string; port: string } = window.location): string {
  if (loc.protocol === 'https:') return `https://${loc.hostname}${loc.port ? `:${loc.port}` : ''}`;
  const host = loc.hostname.includes(':') ? `[${loc.hostname}]` : loc.hostname;
  return `https://${host}:${sys.ports.https}`;
}

// One check per page load and URL (the banner and the HTTPS page share it); recheck() forces a new one.
const cache = new Map<string, Promise<boolean>>();
function probe(url: string, fresh = false): Promise<boolean> {
  if (!fresh && cache.has(url)) return cache.get(url)!;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  const p = fetch(`${url}/api/system?ca-check=${Date.now()}`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal })
    .then(() => true, () => false)
    .finally(() => clearTimeout(timer));
  cache.set(url, p);
  return p;
}

export function useCaTrust(sys: SystemInfo | null | undefined): { state: CaTrustState; url: string | null; recheck: () => void } {
  const url = sys?.tls && sys.ports ? httpsBaseOf(sys) : null;
  const [state, setState] = useState<CaTrustState>(url ? 'checking' : 'off');
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return setState(sys ? 'off' : 'checking');
    let live = true;
    setState('checking');
    void probe(url, n > 0).then((ok) => live && setState(ok ? 'trusted' : 'untrusted'));
    return () => {
      live = false;
    };
  }, [url, n, !!sys]);
  const recheck = useCallback(() => setN((x) => x + 1), []);
  return { state, url, recheck };
}

/** The steps to trust the CA in the browser (the OS steps are on the HTTPS page below). */
function TrustSteps({ url }: { url: string }) {
  return (
    <ol className="small" style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
      <li>
        Download <a href="/api/ca.crt" download="stubyard-ca.crt">stubyard-ca.crt</a>.
      </li>
      <li>Import it as a trusted root (certificate authority): with the OS step below, or in Chrome Settings → Privacy and security → Security → Manage certificates → Authorities → Import, then tick "Trust this certificate for identifying websites". Firefox: Settings → Privacy &amp; Security → Certificates → View Certificates → Authorities → Import.</li>
      <li>Restart the browser, then press Check again.</li>
      <li>
        Still failing? Open <a href={`${url}/api/system`} target="_blank" rel="noopener noreferrer">{url}/api/system</a>: a certificate warning means the CA is not trusted yet; no answer at all means the HTTPS port is not reachable from this machine.
      </li>
    </ol>
  );
}

/** Card on the HTTPS page: Trusted / Not trusted with the steps / checking. */
export function CaTrustCard({ sys }: { sys: SystemInfo | null | undefined }) {
  const { state, url, recheck } = useCaTrust(sys);
  if (state === 'off' || !url) return null;
  return (
    <div className={`card card-pad stack ca-trust ${state}`} data-testid="ca-trust" data-state={state} role="status">
      <div className="row between wrap">
        <h2 style={{ margin: 0 }}>
          {state === 'trusted' ? '✓ Trusted' : state === 'untrusted' ? "This browser doesn't trust the stubyard CA yet" : 'Checking this browser…'}
        </h2>
        <button className="btn" onClick={recheck} disabled={state === 'checking'}>
          Check again
        </button>
      </div>
      {state === 'trusted' && (
        <p className="muted small" style={{ margin: 0 }}>
          This browser loaded <code>{url}</code> without a certificate error: payment and login pages on HTTPS open directly.
        </p>
      )}
      {state === 'untrusted' && (
        <>
          <p className="small" style={{ margin: 0 }}>
            <code>{url}</code> did not load: fake payment and login pages on HTTPS will show "Your connection is not private" until the CA is trusted.
          </p>
          <TrustSteps url={url} />
        </>
      )}
    </div>
  );
}

/** A one-line banner for payment pages, shown only when this browser does not trust the CA. */
export function CaTrustBanner({ sys }: { sys: SystemInfo | null | undefined }) {
  const { state, url } = useCaTrust(sys);
  if (state !== 'untrusted' || !url) return null;
  return (
    <div className="ca-trust-banner" data-testid="ca-trust-banner" role="status">
      This browser doesn't trust the stubyard CA yet, so the HTTPS payment pages (<code>{url}</code>) will show a certificate warning. <Link to="/https">Set up HTTPS</Link>
    </div>
  );
}
