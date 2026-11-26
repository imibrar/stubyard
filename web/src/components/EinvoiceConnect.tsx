import { Link } from 'react-router-dom';
import { caPemUrl, einvoiceBase, ZATCA_ENV_LABEL, type EinvoiceConnect, type EinvoiceInstance } from '../einvoiceApi';
import { useFetch } from '../hooks';
import { CopyUrl, providersPath } from './providerLayout';
import { CodeBlock, ErrorBox } from './ui';

/**
 * Connect tab of the E-invoicing page: the URLs, .env and SDK snippets of one instance. The full panel (OTP, CA,
 * settings) is Providers → E-invoicing → Connect (EinvoiceProviders.tsx), linked from here.
 */
export function EinvoiceConnectTab({ slug, inst }: { slug: string; inst: EinvoiceInstance }) {
  const c = useFetch<EinvoiceConnect>(`${einvoiceBase(slug)}/instances/${encodeURIComponent(inst.slug)}/connect`, [slug, inst.slug, inst.config.env, inst.config.otp]);
  const d = c.data;
  const urls = d?.urls ?? inst.urls;
  const rows: [string, string][] = [
    ['Base URL', urls.envBase],
    ['Compliance CSID', urls.compliance],
    ['Compliance checks', urls.complianceInvoices],
    ['Production CSID', urls.productionCsids],
    ['Reporting', urls.reporting],
    ['Clearance', urls.clearance],
  ];
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <div className="row">
          <h3 className="grow">
            {inst.name} · {ZATCA_ENV_LABEL[inst.config.env]}
          </h3>
          <Link className="btn sm" to={providersPath(slug, 'einvoice', inst.slug)}>
            OTP, CA and settings in Providers
          </Link>
        </div>
        <p className="small muted">Point the EGS or SDK base URL at the base URL below; the other paths follow the real Fatoora routes.</p>
        {rows.map(([k, v]) => (
          <div key={k} className="row nowrap">
            <span className="small muted einv-url-label">{k}</span>
            <CopyUrl url={v} />
          </div>
        ))}
        {d && (
          <p className="small muted">
            CSR certificate template <code>{d.csrTemplate}</code> · first PIH <code className="einv-cut">{d.firstPih}</code>
          </p>
        )}
        {inst.config.caCertPem && (
          <div className="row">
            <a className="btn sm ghost" href={caPemUrl(slug, inst.slug)}>
              Download fake ZATCA CA
            </a>
          </div>
        )}
      </div>
      <ErrorBox error={c.error} />
      {d && <CodeBlock title=".env" code={Object.entries(d.dotenv).map(([k, v]) => `${k}=${v}`).join('\n')} />}
      {d?.snippets.filter((s) => s.id !== 'env').map((s) => <CodeBlock key={s.id} title={s.title} lang={s.lang} code={s.code} />)}
    </div>
  );
}
