import { useState } from 'react';
import { api } from '../api';
import { FileBrowser } from '../components/FileBrowser';
import { Icon } from '../components/people';
import { StorageRules } from '../components/StorageRules';
import { Badge, CodeBlock, Empty, ErrorBox, Modal, fmtBytes, useCopy, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { storageBase, type StorageInstance, type StoragePresets } from '../storageApi';
import { Page } from './ProjectPage';
import '../styles/storage.css';

/**
 * /p/:slug/storage — fake S3-compatible file storage: instances (endpoints, credentials, usage), a file browser
 * (buckets → folders → objects with preview / download / delete / upload), scenario rules and SDK snippets.
 */
export default function StoragePage() {
  const { slug } = useProject();
  const list = useFetch<StorageInstance[]>(storageBase(slug), [slug]);
  const presets = useFetch<StoragePresets>('/api/storage-presets');
  const reload = useDebounced(() => void list.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'storage.changed' || e.type === 'project.reset') reload();
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const instances = list.data ?? [];
  const current = instances.find((i) => i.slug === selected) ?? instances[0] ?? null;

  return (
    <Page
      title="Storage"
      description="Fake file storage: S3-compatible (Amazon S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO, Wasabi), Cloudinary, Google Cloud Storage, Azure Blob and Supabase Storage. Point the SDK at the endpoint; every upload is kept here and logged without its bytes."
      actions={
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Add storage
        </button>
      }
    >
      <ErrorBox error={list.error} />
      {list.data && instances.length === 0 ? (
        <div className="card">
          <Empty title="No storage yet">
            <p className="muted">Add a storage instance; buckets are created on first upload.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              {(presets.data?.presets ?? [])
                .filter((p) => p.available)
                .map((p) => (
                  <button key={p.id} className="btn" onClick={() => void api.post(storageBase(slug), { preset: p.id }).then(() => list.reload())}>
                    {p.name}
                  </button>
                ))}
            </div>
          </Empty>
        </div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid-auto" style={{ ['--min' as string]: '340px' }}>
            {instances.map((i) => (
              <InstanceCard key={i.id} slug={slug} i={i} active={current?.id === i.id} onSelect={() => setSelected(i.slug)} reload={() => void list.reload()} />
            ))}
          </div>
          {current && (
            <>
              <FileBrowser key={current.id} slug={slug} instance={current} />
              <div className="cards-flow">
                <StorageRules slug={slug} instance={current} presets={presets.data} />
                <div className="card">
                  <div className="card-head">
                    <h3>Connect your app — {current.name}</h3>
                  </div>
                  <div className="card-pad stack">
                    <p className="muted small" style={{ margin: 0 }}>
                      Backend code uses the backend endpoint (in Docker: <code>{current.urls.docker}</code>). Presign with the browser endpoint when users upload or download directly. Signatures are accepted for any of the
                      hosts unless the instance is strict.
                    </p>
                    {current.snippets.map((s) => (
                      <CodeBlock key={s.title} title={s.title} code={s.code} />
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {adding && <AddStorageModal slug={slug} presets={presets.data} onClose={() => setAdding(false)} onDone={(s) => (void list.reload(), setSelected(s))} />}
    </Page>
  );
}

const VERIFY_WHAT: Record<string, string> = {
  s3: 'SigV4 signatures',
  gcs: 'V4 signed URLs (GOOG4-RSA-SHA256)',
  azure: 'SAS signatures',
  cloudinary: 'upload signatures and the API secret',
  supabase: 'JWTs against the jwtSecret',
};

function InstanceCard({ slug, i, active, onSelect, reload }: { slug: string; i: StorageInstance; active: boolean; onSelect: () => void; reload: () => void }) {
  const copy = useCopy();
  const toast = useToast();
  const base = storageBase(slug, i.slug);
  const patch = async (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    try {
      await api.patch(base, { config, ...extra });
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete storage "${i.name}" with ${i.usage.objects} files (${fmtBytes(i.usage.bytes)})?`)) return;
    await api.del(base);
    toast('Storage deleted');
    reload();
  };
  const quota = i.usage.quotaBytes || 0;
  const pct = quota ? Math.min(100, Math.round((i.usage.bytes / quota) * 100)) : 0;
  const cred = i.credentials[0];
  const labels = [i.credentialLabels?.[0] || 'key', i.credentialLabels?.[1] || 'secret'];
  return (
    <div className={`card storage-instance${active ? ' active' : ''}`}>
      <div className="card-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <button className="linkish" onClick={onSelect} style={{ fontWeight: 650 }}>
            {i.name}
          </button>{' '}
          <code className="faint">{i.slug}</code>
        </div>
        <div className="row-actions">
          <Badge>{i.presetName}</Badge>
          {i.config.strict && <Badge kind="warn">strict</Badge>}
          {!i.enabled && <Badge kind="bad">disabled</Badge>}
        </div>
      </div>
      <div className="card-pad stack" style={{ gap: 8 }}>
        {(
          [
            ['Backend', i.urls.backend],
            ['Browser', i.urls.browser],
          ] as const
        ).map(([k, v]) => (
          <button key={k} className="cred" style={{ cursor: 'copy', maxWidth: '100%' }} onClick={() => copy(v, `${k} endpoint copied`)} title="Copy">
            <span className="k">{k}</span>
            <span className="ellipsis">{v}</span>
            <Icon name="copy" size={12} />
          </button>
        ))}
        {(cred || i.protocol === 'gcs' || i.protocol === 'cloudinary') && (
          <div className="creds" style={{ marginTop: 0 }}>
            {i.protocol === 'cloudinary' && (
              <button className="cred" style={{ cursor: 'copy' }} onClick={() => copy(String(i.config.cloudName || 'devhub'), 'Cloud name copied')}>
                <span className="k">cloud</span> {String(i.config.cloudName || 'devhub')}
              </button>
            )}
            {cred &&
              ([
                [labels[0], cred.accessKeyId],
                [labels[1], cred.secretAccessKey],
              ] as const).map(([k, v]) => (
                <button key={k} className="cred" style={{ cursor: 'copy', maxWidth: '100%' }} onClick={() => copy(v, `${k} copied`)} title={v}>
                  <span className="k">{k}</span>
                  <span className="ellipsis">{v}</span>
                </button>
              ))}
            {i.protocol === 'gcs' && (
              <a className="cred" href={`${base}/service-account.json`} download={`${i.slug}-service-account.json`} title="Fake service account key for V4 signed URLs (getSignedUrl)">
                <span className="k">key file</span> service-account.json <Icon name="download" size={12} />
              </a>
            )}
            {i.protocol === 's3' && (
              <span className="cred">
                <span className="k">region</span> {i.region}
              </span>
            )}
          </div>
        )}
        <div>
          <div className="row small muted" style={{ justifyContent: 'space-between' }}>
            <span>
              {i.usage.objects} files · {fmtBytes(i.usage.bytes)} · {i.buckets} buckets
            </span>
            <span>{quota ? `quota ${fmtBytes(quota)}` : 'no instance quota'}</span>
          </div>
          {quota > 0 && (
            <div className="usage-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} className={pct > 90 ? 'bad' : ''} />
            </div>
          )}
        </div>
        <div className="row">
          <label className="row small" style={{ gap: 4 }} title="Unknown keys, bad signatures and anonymous access become the provider's real errors">
            <input type="checkbox" checked={!!i.config.strict} onChange={(e) => void patch({ strict: e.target.checked })} /> Strict
          </label>
          <label className="row small" style={{ gap: 4 }} title={`Verify ${VERIFY_WHAT[i.protocol] ?? 'signatures'} (error on mismatch)`}>
            <input type="checkbox" checked={!!i.config.verifySignatures} onChange={(e) => void patch({ verifySignatures: e.target.checked })} /> Verify signatures
          </label>
          <span className="grow" />
          <button className="btn sm ghost" onClick={onSelect} disabled={active}>
            {active ? 'Browsing' : 'Browse'}
          </button>
          <button className="btn sm ghost" onClick={() => void patch({}, { enabled: !i.enabled })}>
            {i.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="btn sm ghost danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function AddStorageModal({ slug, presets, onClose, onDone }: { slug: string; presets: StoragePresets | null; onClose: () => void; onDone: (slug: string) => void }) {
  const available = (presets?.presets ?? []).filter((p) => p.available);
  const [preset, setPreset] = useState(available[0]?.id ?? 's3');
  const [name, setName] = useState('');
  const [instSlug, setInstSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const p = available.find((x) => x.id === preset);
  const save = async () => {
    try {
      const i = await api.post<StorageInstance>(storageBase(slug), { preset, name: name || undefined, slug: instSlug || undefined });
      onDone(i.slug);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      title="Add storage"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Add
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <label className="field">
          Provider
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {available.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          {p && <span className="hint">{p.description}</span>}
        </label>
        <div className="form form-2">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={p?.name} />
          </label>
          <label className="field">
            Slug <span className="hint">Part of the endpoint URL</span>
            <input value={instSlug} onChange={(e) => setInstSlug(e.target.value)} placeholder={preset} />
          </label>
        </div>
        {p?.notes?.map((n) => (
          <p key={n} className="small muted" style={{ margin: 0 }}>
            {n}
          </p>
        ))}
      </div>
    </Modal>
  );
}
