import type { SetupGuide, SystemInfo } from '../api';
import { CaTrustCard } from '../components/CaTrust';
import { CodeBlock, ErrorBox } from '../components/ui';
import { useFetch } from '../hooks';

export default function HttpsPage() {
  const sys = useFetch<SystemInfo>('/api/system');
  // The HTTPS steps are the same for every project; take them from any project's guide or build locally.
  const steps = useFetch<SetupGuide['https']>('/api/https-guide');
  const tls = sys.data?.tls;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>HTTPS setup</h1>
          <p>Most provider SDKs require https:// URLs. stubyard has its own local certificate authority (CA); trust it once per machine.</p>
        </div>
      </div>
      <ErrorBox error={sys.error ?? steps.error} />
      {sys.data && !tls && <div className="error-box">HTTPS is disabled in this stubyard instance.</div>}
      {tls && (
        <div className="stack">
          <CaTrustCard sys={sys.data} />
          <div className="card card-pad stack">
            <h2>1. Download the CA certificate</h2>
            <div className="row">
              <a className="btn primary" href="/api/ca.crt" download="stubyard-ca.crt">
                Download stubyard-ca.crt
              </a>
              <span className="muted small">
                HTTPS port <code>{sys.data?.ports.https}</code>
              </span>
            </div>
            <dl className="kv bare">
              <dt>Fingerprint</dt>
              <dd className="mono small">{tls.caFingerprint}</dd>
              <dt>Created</dt>
              <dd>{new Date(tls.caCreatedAt).toLocaleString()}</dd>
              <dt>Valid for</dt>
              <dd>
                {tls.names.map((n) => (
                  <code key={n} style={{ marginRight: 8 }}>
                    {n}
                  </code>
                ))}
              </dd>
            </dl>
            <p className="muted small" style={{ margin: 0 }}>
              Need another hostname? Start stubyard with <code>STUBYARD_TLS_NAMES=myhost.local,10.0.0.5</code>. Only trust this CA on development machines.
            </p>
          </div>
          <div className="card card-pad stack">
            <h2>2. Trust it where your app runs</h2>
            <p className="muted" style={{ margin: 0 }}>
              Do the OS step once, or the language step if your runtime keeps its own trust store.
            </p>
            <div className="grid-snippets">
              {steps.data?.steps.map((s) => <CodeBlock key={s.title} title={s.title} code={s.code} />)}
            </div>
          </div>
          <div className="card card-pad stack">
            <h2>3. Check it</h2>
            <div className="grid-snippets">
              <CodeBlock code={`curl https://localhost:${sys.data?.ports.https}/api/system`} lang="shell" />
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              If this prints JSON without a certificate error, HTTPS is set up correctly.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
