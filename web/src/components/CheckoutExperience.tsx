import { useState } from 'react';
import { api } from '../api';
import { useFetch, useHubEvents } from '../hooks';
import { payBase, type CheckoutConfig, type CheckoutMode, type Fidelity, type PaymentInstance, type PaymentReference } from '../paymentsApi';
import { Icon } from './people';
import { Badge, Empty, ErrorBox, useToast } from './ui';
import '../styles/payments-checkout.css';

/**
 * Payments → Checkout pages: per payment provider, the one-click Realistic / Classic switch of its hosted page plus the
 * page language, timings and test-controls drawer; below, every provider × integration mode with its fidelity.
 */

const STATUS: Record<CheckoutMode['status'], { label: string; kind: string; title: string }> = {
  realistic: { label: 'Realistic layout', kind: 'ok', title: 'Its own layout modelled on the provider (neutral stubyard look, no logos)' },
  generic: { label: 'Generic page', kind: 'accent', title: 'The shared realistic page; a provider layout comes in a later phase' },
  sdk: { label: 'Fake SDK', kind: '', title: "Works through stubyard's fake SDK with the generic look" },
  planned: { label: 'Planned', kind: 'warn', title: 'Not simulated yet: planned for the phase shown' },
  none: { label: 'Not planned', kind: '', title: 'Not simulated and not planned' },
};
/** Providers whose instance serves a demo shop at {instance browser URL}/demo (the fake SDKs, tried without an app). */
const DEMO_PRESETS = new Set(['stripe-checkout', 'paypal', 'moyasar', 'geidea', 'hyperpay', 'checkout', 'tap', 'myfatoorah', 'paytabs', 'aps']);

const LOCALE_LABEL: Record<string, string> = { auto: 'auto language', en: 'English', ar: 'Arabic' };

const FID: Record<Fidelity, { label: string; kind: string }> = {
  verified: { label: 'verified', kind: 'ok' },
  partial: { label: 'partly', kind: 'warn' },
  assumed: { label: 'assumed', kind: '' },
};

export function CheckoutExperience({ slug }: { slug: string }) {
  const list = useFetch<PaymentInstance[]>(`${payBase(slug)}/payment-instances`, [slug]);
  const ref = useFetch<PaymentReference>('/api/payment-presets');
  useHubEvents(slug, (e) => {
    if (e.type === 'payments.changed' || e.type === 'project.reset') void list.reload();
  });
  const modes = (ref.data?.presets ?? []).flatMap((p) => (p.experiences ?? []).map((m) => ({ ...m, providerName: p.name })));
  return (
    <div className="pay-cx">
      <p className="small muted">
        Every stubyard payment page shows a "TEST · stubyard simulator" notice and a [TEST] title, in both views. Realistic pages follow the provider's own flow (fields, 3-D Secure modal, errors, return) with the test shortcuts in a "Test controls" drawer; Pay, Decline and Cancel stay on the page. Classic is the earlier stubyard page with every test button in view. Tests can force a view per payment with <code>?ui=classic</code> or <code>?ui=realistic</code> on the page URL, and the language with <code>?stubyard_lang=ar</code>.
      </p>
      <ErrorBox error={list.error ?? ref.error} />
      {list.data && list.data.length === 0 && <Empty title="No payment providers yet">Add one under Providers → Payments; new providers start on the realistic view.</Empty>}
      <div className="card pay-cx-list">
        {(list.data ?? []).map((inst) => (
          <InstanceCard key={inst.id} slug={slug} inst={inst} modes={modes.filter((m) => m.preset === inst.preset)} onSaved={() => void list.reload()} />
        ))}
      </div>
      {modes.length > 0 && (
        <details className="card pay-cx-coverage">
          <summary className="card-head">
            <Icon name="chevron" size={14} />
            <h3 className="grow">Coverage: providers and integration modes</h3>
            <span className="small faint">{modes.length} modes</span>
          </summary>
          <p className="small muted card-pad">"API" says how closely the requests, responses and webhooks match the provider's documentation; "Screens" how closely the page matches the provider's real screens. Verified: taken from the official docs; partly: documented flow, look assembled from general knowledge; assumed: no public source yet. Both are tracked separately: a page can follow the documented flow before its look is checked against real screenshots.</p>
          <div className="table-wrap">
            <table className="pay-cx-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Mode</th>
                  <th>Page</th>
                  <th>API</th>
                  <th>Screens</th>
                  <th>Phase</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {modes.map((m) => (
                  <tr key={`${m.preset}:${m.mode}`}>
                    <td>{m.providerName}</td>
                    <td>{m.label}</td>
                    <td>
                      <Badge kind={STATUS[m.status].kind} title={STATUS[m.status].title}>
                        {STATUS[m.status].label}
                      </Badge>
                    </td>
                    <td>
                      <Badge kind={FID[m.api].kind}>{FID[m.api].label}</Badge>
                    </td>
                    <td>
                      <Badge kind={FID[m.screens].kind}>{FID[m.screens].label}</Badge>
                    </td>
                    <td className="small">{m.phase}</td>
                    <td className="notes small muted">{m.notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function InstanceCard({ slug, inst, modes, onSaved }: { slug: string; inst: PaymentInstance; modes: (CheckoutMode & { providerName: string })[]; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const cfg = inst.config as CheckoutConfig;
  const realistic = modes.filter((m) => m.status === 'realistic').length;
  const bodyId = `pay-cx-body-${inst.slug}`;
  const view = cfg.experience === 'realistic' ? 'realistic' : 'classic';
  const save = async (patch: CheckoutConfig, msg: string) => {
    setBusy(true);
    try {
      await api.patch(`${payBase(slug)}/payment-instances/${encodeURIComponent(inst.slug)}`, { config: patch });
      toast(msg);
      onSaved();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const select = <K extends keyof CheckoutConfig>(key: K, label: string, options: [string, string][], dflt: string) => (
    <label>
      <span className="muted">{label}</span>
      <select value={(cfg[key] as string | undefined) ?? dflt} disabled={busy || view === 'classic'} onChange={(e) => void save({ [key]: e.target.value } as CheckoutConfig, `${label} saved`)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <article className={`pay-cx-card ${open ? 'open' : ''}`} data-testid={`checkout-view-${inst.slug}`}>
      <div className="pay-cx-head">
        <button type="button" className="pay-cx-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} title={open ? 'Hide page options' : 'Language, timings and test controls'}>
          <span className="pay-cx-chev" aria-hidden>
            <Icon name="chevron" size={14} />
          </span>
          <span className="pay-cx-name">
            <h3>{inst.name}</h3>
            <span className="small muted">
              {inst.slug} · {modes.length} mode{modes.length === 1 ? '' : 's'}
              {realistic > 0 && ` · ${realistic} realistic`}
              {view === 'realistic' && ` · ${LOCALE_LABEL[cfg.pageLocale ?? 'auto'] ?? cfg.pageLocale}`}
            </span>
          </span>
        </button>
        {DEMO_PRESETS.has(inst.preset) && (
          <a className="btn sm ghost pay-cx-demo-link" href={`${inst.urls.browser}/demo`} target="_blank" rel="noopener noreferrer" data-testid={`checkout-demo-${inst.slug}`} title={`A sample merchant page that loads the fake ${inst.presetName} SDK and prints every callback`}>
            <Icon name="external" size={13} /> Demo shop
          </a>
        )}
        <div className="pay-cx-seg" role="group" aria-label={`Payment page view for ${inst.name}`}>
          {(['realistic', 'classic'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} disabled={busy} onClick={() => view !== v && void save({ experience: v }, v === 'realistic' ? 'Realistic payment pages on' : 'Classic payment pages on')}>
              {v === 'realistic' ? 'Realistic' : 'Classic'}
            </button>
          ))}
        </div>
      </div>
      {open && (
        <div className="pay-cx-body" id={bodyId}>
          <div className="pay-cx-modes">
            {modes.map((m) => (
              <Badge key={m.mode} kind={STATUS[m.status].kind} title={STATUS[m.status].title}>
                {m.label}: {STATUS[m.status].label.toLowerCase()}
              </Badge>
            ))}
          </div>
          <div className="pay-cx-opts">
            {select('pageLocale', 'Language', [['auto', "Auto (the request's locale)"], ['en', 'English'], ['ar', 'Arabic (RTL)']], 'auto')}
            {select('pageTimings', 'Timings', [['auto', 'Auto (fast under automation)'], ['realistic', 'Realistic'], ['fast', 'Fast']], 'auto')}
            {select('pageDrawer', 'Test controls', [['closed', 'Collapsed'], ['open', 'Open']], 'closed')}
          </div>
          {DEMO_PRESETS.has(inst.preset) && <p className="small muted pay-cx-demo">Demo shop: a sample merchant page that loads the fake {inst.presetName} SDK and prints every callback.</p>}
          {view === 'classic' && <p className="small muted">Classic page: every test button in view. Language, timings and the drawer apply to the realistic view.</p>}
        </div>
      )}
    </article>
  );
}
