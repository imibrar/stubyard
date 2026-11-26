// CA trust check (dashboard): can this browser load stubyard over HTTPS without a certificate error? A no-cors fetch
// of https://<host>:<https port>/api/system resolves (opaque) when the certificate is trusted and rejects when the
// browser refuses it (or the port is not reachable). Nothing is read from the answer.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SystemInfo } from '../api';

export type CaTrustState = 'checking' | 'trusted' | 'untrusted' | 'off';

/** Where the check points and why: STUBYARD_PUBLIC_URL, this https page, the same ports as inside stubyard, or a guess. */
export interface HttpsTarget {
  url: string;
  how: 'public-url' | 'this-page' | 'same-ports' | 'host-ports' | 'guess' | 'custom';
  /** The guessed URL (port mapping); the person can change it. */
  guess: string | null;
}

const STORE_KEY = 'stubyard.caCheckUrl';
const storedUrl = (): string | null => {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
};
/** An https origin, or null. */
export function httpsOrigin(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The HTTPS address to check. `ports` are the ports inside stubyard; behind a port mapping (Docker 34000→4000) the
 * browser reaches HTTPS on another port, so: STUBYARD_PUBLIC_URL when it is https; this page when it is https; the
 * in-stubyard HTTPS port when this page uses the in-stubyard HTTP port; the published HTTPS host port when this page is on the published HTTP host port; else a guess (this page's port moved by the
 * same offset, 34000 → 34443) or the address the person typed before.
 */
export function httpsTargetOf(
  sys: Pick<SystemInfo, 'ports' | 'hostPorts'>,
  publicUrl: string | null | undefined,
  loc: { protocol: string; hostname: string; port: string } = window.location,
  stored: string | null = storedUrl(),
): HttpsTarget {
  const pub = httpsOrigin(publicUrl);
  if (pub) return { url: pub, how: 'public-url', guess: null };
  const host = loc.hostname.includes(':') ? `[${loc.hostname}]` : loc.hostname;
  if (loc.protocol === 'https:') return { url: `https://${host}${loc.port ? `:${loc.port}` : ''}`, how: 'this-page', guess: null };
  const pagePort = Number(loc.port || 80);
  if (pagePort === sys.ports.http) return { url: `https://${host}:${sys.ports.https}`, how: 'same-ports', guess: null };
  if (sys.hostPorts && pagePort === sys.hostPorts.http) return { url: `https://${host}:${sys.hostPorts.https}`, how: 'host-ports', guess: null };
  const moved = pagePort + (sys.ports.https - sys.ports.http);
  const guess = `https://${host}${moved === 443 ? '' : `:${moved > 0 && moved < 65536 ? moved : sys.ports.https}`}`;
  const own = httpsOrigin(stored);
  return own ? { url: own, how: 'custom', guess } : { url: guess, how: 'guess', guess };
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

/** `publicUrl`: STUBYARD_PUBLIC_URL from /api/https-guide (undefined while it loads). */
export function useCaTrust(
  sys: SystemInfo | null | undefined,
  publicUrl: string | null | undefined,
): { state: CaTrustState; target: HttpsTarget | null; recheck: () => void; setUrl: (url: string | null) => boolean } {
  const [n, setN] = useState(0);
  const target = sys?.tls && sys.ports && publicUrl !== undefined ? httpsTargetOf(sys, publicUrl) : null;
  const url = target?.url ?? null;
  const [state, setState] = useState<CaTrustState>('checking');
  useEffect(() => {
    if (!url) return setState(sys && !sys.tls ? 'off' : 'checking');
    let live = true;
    setState('checking');
    void probe(url, n > 0).then((ok) => live && setState(ok ? 'trusted' : 'untrusted'));
    return () => {
      live = false;
    };
  }, [url, n, !!sys]);
  const recheck = useCallback(() => setN((x) => x + 1), []);
  /** Remember another address (null: back to the guess). False when it is not an https URL. */
  const setUrl = useCallback((v: string | null) => {
    const o = v === null ? null : httpsOrigin(v);
    if (v !== null && !o) return false;
    try {
      if (o) localStorage.setItem(STORE_KEY, o);
      else localStorage.removeItem(STORE_KEY);
    } catch {
      /* private mode: this page only */
    }
    setN((x) => x + 1);
    return true;
  }, []);
  return { state, target, recheck, setUrl };
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

const HOW: Record<HttpsTarget['how'], string> = {
  'public-url': 'from STUBYARD_PUBLIC_URL',
  'this-page': 'this page',
  'same-ports': "this host on stubyard's HTTPS port",
  'host-ports': 'this host on the HTTPS port stubyard is published on (STUBYARD_HOST_HTTPS_PORT)',
  guess: 'a guess: this page is on a mapped port, so the HTTPS port is assumed to be mapped the same way',
  custom: 'the address you entered',
};

/** Behind a port mapping: the address to check, editable and remembered in this browser. */
function TargetInput({ target, setUrl }: { target: HttpsTarget; setUrl: (url: string | null) => boolean }) {
  const [v, setV] = useState(target.url);
  const [bad, setBad] = useState(false);
  useEffect(() => setV(target.url), [target.url]);
  const submit = () => setBad(!setUrl(v));
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label className="small" htmlFor="ca-check-url">
        stubyard's HTTPS address from this browser (the host port mapped to HTTPS)
      </label>
      <div className="row wrap" style={{ gap: 8 }}>
        <input
          id="ca-check-url"
          data-testid="ca-check-url"
          className="mono"
          style={{ flex: '1 1 220px', minWidth: 0 }}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="https://localhost:4443"
        />
        <button className="btn" onClick={submit}>
          Check this address
        </button>
        {target.how === 'custom' && target.guess && (
          <button className="btn ghost" onClick={() => setUrl(null)}>
            Use the guess ({target.guess})
          </button>
        )}
      </div>
      {bad && <span className="small" style={{ color: 'var(--bad)' }}>Enter an https:// address, e.g. https://localhost:34443</span>}
    </div>
  );
}

/** Card on the HTTPS page: Trusted / Not trusted with the steps / checking, and which URL was checked. */
export function CaTrustCard({ sys, publicUrl }: { sys: SystemInfo | null | undefined; publicUrl: string | null | undefined }) {
  const { state, target, recheck, setUrl } = useCaTrust(sys, publicUrl);
  if (state === 'off' || !target) return null;
  const url = target.url;
  const editable = target.how === 'guess' || target.how === 'custom';
  return (
    <div className={`card card-pad stack ca-trust ${state}`} data-testid="ca-trust" data-state={state} data-url={url} data-how={target.how} role="status">
      <div className="row between wrap">
        <h2 style={{ margin: 0 }}>
          {state === 'trusted' ? '✓ Trusted' : state === 'untrusted' ? "This browser doesn't trust the stubyard CA yet" : 'Checking this browser…'}
        </h2>
        <button className="btn" onClick={recheck} disabled={state === 'checking'}>
          Check again
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }} data-testid="ca-checked-url">
        Checked <code>{url}</code> ({HOW[target.how]}).
      </p>
      {editable && <TargetInput target={target} setUrl={setUrl} />}
      {state === 'trusted' && (
        <p className="muted small" style={{ margin: 0 }}>
          This browser loaded <code>{url}</code> without a certificate error: payment and login pages on HTTPS open directly.
        </p>
      )}
      {state === 'untrusted' && (
        <>
          <p className="small" style={{ margin: 0 }}>
            <code>{url}</code> did not load: fake payment and login pages on HTTPS will show "Your connection is not private" until the CA is trusted
            {editable ? ', or this is not the right address (change it above)' : ''}.
          </p>
          <TrustSteps url={url} />
        </>
      )}
    </div>
  );
}

/** A one-line banner for payment pages, shown only when this browser does not trust the CA. */
export function CaTrustBanner({ sys, publicUrl }: { sys: SystemInfo | null | undefined; publicUrl: string | null | undefined }) {
  const { state, target } = useCaTrust(sys, publicUrl);
  if (state !== 'untrusted' || !target) return null;
  return (
    <div className="ca-trust-banner" data-testid="ca-trust-banner" role="status">
      This browser could not load <code>{target.url}</code> without a certificate error, so the HTTPS payment pages may show a warning. <Link to="/https">Check HTTPS setup</Link>
    </div>
  );
}
