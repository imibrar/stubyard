import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { FileBrowser } from '../components/FileBrowser';
import { Icon } from '../components/people';
import { StorageRules } from '../components/StorageRules';
import { Badge, CodeBlock, Empty, ErrorBox, Modal, fmtBytes, useCopy, useToast } from '../components/ui';
import { useGate } from '../auth';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { storageBase, type StorageCaps, type StorageInstance, type StoragePresets } from '../storageApi';
import { Page } from './ProjectPage';
import '../styles/storage.css';

/**
 * /p/:slug/storage — fake S3-compatible file storage: instances (endpoints, credentials, usage), a file browser
 * (buckets → folders → objects with preview / download / delete / upload), limits, scenario rules and SDK snippets.
 * Links: ?instance=<slug>&bucket=<name>&key=<key> open the browser on that file (Overview "Files" card).
 */
export default function StoragePage() {
  const { slug } = useProject();
  const g = useGate(slug)('project.providers');
  const list = useFetch<StorageInstance[]>(storageBase(slug), [slug]);
  const presets = useFetch<StoragePresets>('/api/storage-presets');
  const reload = useDebounced(() => void list.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'storage.changed' || e.type === 'project.reset') reload();
  });
  const [params] = useSearchParams();
  const linkInstance = params.get('instance');
  const [selected, setSelected] = useState<string | null>(linkInstance);
  useEffect(() => {
    if (linkInstance) setSelected(linkInstance);
  }, [linkInstance]);
  const [adding, setAdding] = useState(false);
  const instances = list.data ?? [];
  // One instance: its browser is open right away; several: the selected one (or the first).
  const current = instances.find((i) => i.slug === selected) ?? instances[0] ?? null;
  const linked = current && current.slug === linkInstance;

  return (
    <Page
      title="Storage"
      description="Fake file storage: S3-compatible (Amazon S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO, Wasabi), Cloudinary, Google Cloud Storage, Azure Blob and Supabase Storage. Point the SDK at the endpoint; every upload is kept here and logged without its bytes."
      actions={
        <button className="btn primary" onClick={() => setAdding(true)} {...g}>
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
                  <button key={p.id} className="btn" onClick={() => void api.post(storageBase(slug), { preset: p.id }).then(() => list.reload())} {...g}>
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
              <FileBrowser key={`${current.id}:${linked ? params.get('bucket') + '/' + params.get('key') : ''}`} slug={slug} instance={current} initialBucket={linked ? params.get('bucket') : null} initialKey={linked ? params.get('key') : null} />
              <div className="cards-flow">
                <LimitsPanel key={current.id} slug={slug} i={current} caps={presets.data?.caps ?? null} onSaved={() => void list.reload()} />
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
  const g = useGate(slug)('project.providers');
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
  const maxFiles = i.usage.maxObjects || 0;
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
              <button className="cred" style={{ cursor: 'copy' }} onClick={() => copy(String(i.config.cloudName || 'stubyard'), 'Cloud name copied')}>
                <span className="k">cloud</span> {String(i.config.cloudName || 'stubyard')}
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
              {maxFiles ? `${i.usage.objects} / ${maxFiles} files` : `${i.usage.objects} files`} · {fmtBytes(i.usage.bytes)} · {i.buckets} buckets
            </span>
            <span className={maxFiles && i.usage.objects >= maxFiles ? 'bad-fg' : undefined}>{maxFiles && i.usage.objects >= maxFiles ? 'file limit reached' : quota ? `quota ${fmtBytes(quota)}` : 'no instance quota'}</span>
          </div>
          {quota > 0 && (
            <div className="usage-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} className={pct > 90 ? 'bad' : ''} />
            </div>
          )}
        </div>
        <div className="row">
          <label className="row small" style={{ gap: 4 }} title="Unknown keys, bad signatures and anonymous access become the provider's real errors">
            <input type="checkbox" checked={!!i.config.strict} onChange={(e) => void patch({ strict: e.target.checked })} disabled={g.disabled} /> Strict
          </label>
          <label className="row small" style={{ gap: 4 }} title={`Verify ${VERIFY_WHAT[i.protocol] ?? 'signatures'} (error on mismatch)`}>
            <input type="checkbox" checked={!!i.config.verifySignatures} onChange={(e) => void patch({ verifySignatures: e.target.checked })} disabled={g.disabled} /> Verify signatures
          </label>
          <span className="grow" />
          <button className="btn sm ghost" onClick={onSelect} disabled={active}>
            {active ? 'Browsing' : 'Browse'}
          </button>
          <button className="btn sm ghost" onClick={() => void patch({}, { enabled: !i.enabled })} {...g}>
            {i.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="btn sm ghost danger" onClick={remove} {...g}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- limits

const MiB = 1024 * 1024;
const UNITS = { MB: MiB, GB: 1024 * MiB } as const;
type Unit = keyof typeof UNITS;
interface SizeField {
  value: string;
  unit: Unit;
}
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

const trimNum = (n: number) => String(Math.round(n * 100) / 100);
function toField(bytes: number | null | undefined): SizeField {
  if (!bytes) return { value: '', unit: 'MB' };
  return bytes >= UNITS.GB ? { value: trimNum(bytes / UNITS.GB), unit: 'GB' } : { value: trimNum(bytes / UNITS.MB), unit: 'MB' };
}
/** Bytes, null (empty or 0 = no limit) or an error message. */
function fromField(f: SizeField, label: string): number | null | string {
  const s = f.value.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return `${label}: enter a positive number, or leave it empty for no limit`;
  return Math.round(n * UNITS[f.unit]) || null;
}

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="usage-bar" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} className={pct >= 100 ? 'bad' : pct > 90 ? 'warn' : ''} />
    </div>
  );
}

function SizeInput({ id, field, onChange, disabled }: { id: string; field: SizeField; onChange: (f: SizeField) => void; disabled?: boolean }) {
  return (
    <div className="row nowrap limit-input">
      <input id={id} type="number" min={0} step="any" inputMode="decimal" placeholder="No limit" value={field.value} onChange={(e) => onChange({ ...field, value: e.target.value })} disabled={disabled} />
      <select aria-label="Unit" value={field.unit} onChange={(e) => onChange({ ...field, unit: e.target.value as Unit })} disabled={disabled}>
        <option value="MB">MB</option>
        <option value="GB">GB</option>
      </select>
    </div>
  );
}

/**
 * Per-instance limits: max files (maxObjects), max total size (quotaBytes), max file size (maxObjectBytes); empty =
 * no limit. Shows usage against each and the server-wide caps from the environment (read only).
 */
function LimitsPanel({ slug, i, caps, onSaved }: { slug: string; i: StorageInstance; caps: StorageCaps | null; onSaved: () => void }) {
  const g = useGate(slug)('project.providers');
  const toast = useToast();
  const [files, setFiles] = useState(i.config.maxObjects ? String(i.config.maxObjects) : '');
  const [total, setTotal] = useState<SizeField>(() => toField(i.config.quotaBytes));
  const [single, setSingle] = useState<SizeField>(() => toField(i.config.maxObjectBytes));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setError(null);
    const f = files.trim();
    const maxObjects = f ? Number(f) : null;
    if (maxObjects !== null && (!Number.isInteger(maxObjects) || maxObjects < 0)) return setError('Max files: enter a whole number, or leave it empty for no limit');
    const quotaBytes = fromField(total, 'Max total size');
    const maxObjectBytes = fromField(single, 'Max file size');
    for (const v of [quotaBytes, maxObjectBytes]) if (typeof v === 'string') return setError(v);
    setSaving(true);
    try {
      await api.patch(storageBase(slug, i.slug), { config: { maxObjects: maxObjects || null, quotaBytes, maxObjectBytes } });
      toast('Limits saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const maxFiles = i.usage.maxObjects || 0;
  const quota = i.usage.quotaBytes || 0;
  const effFile = i.usage.maxObjectBytes;
  const capped = !!i.config.maxObjectBytes && effFile < Number(i.config.maxObjectBytes);
  const idp = `lim-${i.id}`;
  return (
    <section className="card limits-panel" aria-labelledby={`${idp}-h`}>
      <div className="card-head">
        <h3 id={`${idp}-h`}>Limits — {i.name}</h3>
        <button className="btn sm primary" onClick={() => void save()} disabled={saving || !!g.disabled} title={g.title}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="card-pad stack" style={{ gap: 12 }}>
        <p className="muted small" style={{ margin: 0 }}>
          Uploads over a limit get the provider's own quota error; overwriting an existing file is always allowed. Leave a field empty for no limit.
        </p>
        <ErrorBox error={error} />
        <div className="limits-grid">
          <div className="limit">
            <label className="small" htmlFor={`${idp}-files`}>
              Max files
            </label>
            <input id={`${idp}-files`} type="number" min={0} step={1} inputMode="numeric" placeholder="No limit" value={files} onChange={(e) => setFiles(e.target.value)} disabled={g.disabled} />
            <div className="limit-usage small">
              <span>
                <strong>{i.usage.objects.toLocaleString()}</strong> {maxFiles ? `/ ${maxFiles.toLocaleString()} files` : 'files · no limit'}
              </span>
            </div>
            {maxFiles > 0 && <Meter value={i.usage.objects} max={maxFiles} label="Files used" />}
          </div>
          <div className="limit">
            <label className="small" htmlFor={`${idp}-total`}>
              Max total size
            </label>
            <SizeInput id={`${idp}-total`} field={total} onChange={setTotal} disabled={g.disabled} />
            <div className="limit-usage small">
              <span>
                <strong>{fmtBytes(i.usage.bytes)}</strong> {quota ? `/ ${fmtBytes(quota)}` : '· no limit'}
              </span>
            </div>
            {quota > 0 && <Meter value={i.usage.bytes} max={quota} label="Storage used" />}
          </div>
          <div className="limit">
            <label className="small" htmlFor={`${idp}-file`}>
              Max file size
            </label>
            <SizeInput id={`${idp}-file`} field={single} onChange={setSingle} disabled={g.disabled} />
            <div className="limit-usage small">
              <span>{effFile >= NO_LIMIT ? 'No limit' : <>Effective: <strong>{fmtBytes(effFile)}</strong>{capped ? ' (server cap)' : ''}</>}</span>
            </div>
          </div>
        </div>
        {caps && (
          <p className="faint small limits-caps" style={{ margin: 0 }}>
            Server limits (environment, read only; the tightest limit wins): all projects {caps.storageMaxMb ? `${caps.storageMaxMb} MB` : 'no limit'} (<code>STUBYARD_STORAGE_MAX_MB</code>), each project{' '}
            {caps.storageProjectMb ? `${caps.storageProjectMb} MB` : 'no limit'} (<code>STUBYARD_STORAGE_PROJECT_MB</code>), each file {caps.storageMaxObjectMb ? `${caps.storageMaxObjectMb} MB` : 'no limit'} (
            <code>STUBYARD_STORAGE_MAX_OBJECT_MB</code>){caps.storageRetentionDays ? `; files older than ${caps.storageRetentionDays} days are removed` : ''}.
          </p>
        )}
      </div>
    </section>
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
