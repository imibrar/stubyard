import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, qs } from '../api';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { storageBase, uploadFile, type ObjectPage, type StorageBucket, type StorageInstance, type StorageObject, type StorageUploadInfo } from '../storageApi';
import { Icon } from './people';
import { Badge, Drawer, Empty, ErrorBox, Modal, fmtBytes, timeAgo, useCopy, useToast } from './ui';

/** Buckets → folders (delimiter "/") → objects, with upload (drag and drop, through the __hub data-plane endpoint). */
export function FileBrowser({ slug, instance }: { slug: string; instance: StorageInstance }) {
  const base = storageBase(slug, instance.slug);
  const buckets = useFetch<StorageBucket[]>(`${base}/buckets`, [base]);
  const uploads = useFetch<StorageUploadInfo[]>(`${base}/uploads`, [base]);
  const [bucketName, setBucketName] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [search, setSearch] = useState('');
  const [newBucket, setNewBucket] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [open, setOpen] = useState<StorageObject | null>(null);
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const list = buckets.data ?? [];
  // Default: the bucket with the most files (most likely the one the app uses).
  const bucket = list.find((b) => b.name === bucketName) ?? [...list].sort((a, b) => b.objects - a.objects)[0] ?? null;
  const objectsUrl = bucket ? `${base}/buckets/${encodeURIComponent(bucket.name)}/objects${qs(search ? { search, limit: 500 } : { prefix, delimiter: '/', limit: 500 })}` : null;
  const page = useFetch<ObjectPage>(objectsUrl, [objectsUrl]);
  const reload = useDebounced(() => {
    void buckets.reload();
    void page.reload();
    void uploads.reload();
  }, 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'storage.changed' || e.type === 'project.reset') reload();
  });
  useEffect(() => setPrefix(''), [bucket?.name]);

  const upload = async (files: FileList | File[]) => {
    if (!bucket) return toast('Create a bucket first');
    const arr = [...files];
    try {
      for (const [n, f] of arr.entries()) {
        setBusy(`Uploading ${n + 1}/${arr.length}: ${f.name}`);
        await uploadFile(slug, instance.slug, bucket.name, prefix + f.name, f);
      }
      toast(`Uploaded ${arr.length} file${arr.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  };
  const bucketAction = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const bUrl = bucket ? `${base}/buckets/${encodeURIComponent(bucket.name)}` : '';
  const crumbs = prefix.split('/').filter(Boolean);
  const pending = (uploads.data ?? []).filter((u) => !bucket || u.bucket === bucket.name);

  return (
    <div className={`card file-browser${drag ? ' dragging' : ''}`} onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div className="card-head">
        <h3 className="row">
          <Icon name="folder" size={16} /> Files — {instance.name}
        </h3>
        <div className="row">
          <button className="btn sm" onClick={() => setNewBucket(true)}>
            <Icon name="plus" size={12} /> Bucket
          </button>
          <button className="btn sm primary" onClick={() => fileInput.current?.click()} disabled={!bucket || !!busy}>
            Upload
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
        </div>
      </div>
      {list.length === 0 ? (
        <Empty title="No buckets yet">
          <p className="muted small">Create one here, or let the app create it: the first upload to a new bucket creates it automatically.</p>
        </Empty>
      ) : (
        <>
          <div className="chips bucket-chips">
            {list.map((b) => (
              <button key={b.id} className={`chip${bucket?.id === b.id ? ' active' : ''}`} onClick={() => setBucketName(b.name)}>
                {b.name} <span className="n">{b.objects}</span>
                {b.public && <span className="n">public</span>}
              </button>
            ))}
          </div>
          {bucket && (
            <div className="row fb-toolbar storage-form">
              <div className="row grow crumbs-row" style={{ minWidth: 0 }}>
                <button className="linkish" onClick={() => setPrefix('')}>
                  {bucket.name}
                </button>
                {crumbs.map((c, n) => (
                  <span key={n} className="row" style={{ gap: 4 }}>
                    <span className="faint">/</span>
                    <button className="linkish" onClick={() => setPrefix(crumbs.slice(0, n + 1).join('/') + '/')}>
                      {c}
                    </button>
                  </span>
                ))}
              </div>
              <input type="search" placeholder="Search keys…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 0, flex: '0 1 220px' }} />
              <div className="row-actions">
                <label className="row nowrap small" style={{ gap: 4 }} title="Anonymous GET allowed (like a public-read bucket)">
                  <input type="checkbox" checked={bucket.public} onChange={(e) => void bucketAction(() => api.patch(bUrl, { public: e.target.checked }), e.target.checked ? 'Bucket is public' : 'Bucket is private')} /> Public
                </label>
                <select
                  value={bucket.cors.mode}
                  title="CORS"
                  onChange={(e) => void bucketAction(() => api.patch(bUrl, { cors: { mode: e.target.value, rules: bucket.cors.rules ?? [] } }), `CORS: ${e.target.value}`)}
                >
                  <option value="permissive">CORS: permissive</option>
                  <option value="rules">CORS: S3 rules</option>
                  <option value="none">CORS: none</option>
                </select>
                <button className="btn sm ghost" onClick={() => confirm(`Delete all ${bucket.objects} files in "${bucket.name}"?`) && void bucketAction(() => api.post(`${bUrl}/empty`), 'Bucket emptied')}>
                  Empty
                </button>
                <button className="btn sm ghost danger" onClick={() => confirm(`Delete bucket "${bucket.name}" and its ${bucket.objects} files?`) && void bucketAction(() => api.del(`${bUrl}?force=1`), 'Bucket deleted')}>
                  Delete
                </button>
              </div>
            </div>
          )}
          {busy && <p className="small muted" style={{ padding: '0 14px' }}>{busy}</p>}
          <ErrorBox error={page.error} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th className="col-sm">Type</th>
                  <th className="col-sm">Modified</th>
                  <th className="col-md">Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(page.data?.prefixes ?? []).map((p) => (
                  <tr key={p} className="clickable" onClick={() => setPrefix(p)}>
                    <td className="cell-fill">
                      <span className="row nowrap" style={{ gap: 6 }}>
                        <Icon name="folder" size={14} />
                        <span className="ellipsis">{p.slice(prefix.length)}</span>
                      </span>
                    </td>
                    <td className="faint">—</td>
                    <td className="col-sm" />
                    <td className="col-sm" />
                    <td className="col-md" />
                    <td />
                  </tr>
                ))}
                {(page.data?.objects ?? []).map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => setOpen(o)}>
                    <td className="cell-fill">
                      <span className="ellipsis" title={o.key} style={{ display: 'block' }}>
                        {search ? o.key : o.key.slice(prefix.length)}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtBytes(o.size)}</td>
                    <td className="col-sm faint" style={{ whiteSpace: 'nowrap' }}>
                      {o.contentType ?? '—'}
                    </td>
                    <td className="col-sm faint" style={{ whiteSpace: 'nowrap' }} title={o.updatedAt}>
                      {timeAgo(o.updatedAt)}
                    </td>
                    <td className="col-md">
                      <span className="row nowrap" style={{ gap: 4 }}>
                        <Badge>{o.source}</Badge>
                        {o.runId && <Badge kind="accent">run</Badge>}
                        {o.public && <Badge kind="warn">public</Badge>}
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                      <a className="btn xs ghost" href={`${o.urls.content}&download=1`} title="Download" aria-label={`Download ${o.key}`}>
                        ↓
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.data && !page.data.objects.length && !page.data.prefixes.length && (
            <p className="muted small" style={{ padding: '12px 14px', margin: 0 }}>
              {search ? 'No keys match.' : 'Empty. Drop files here or use Upload.'}
            </p>
          )}
          {page.data?.truncated && <p className="faint small" style={{ padding: '8px 14px', margin: 0 }}>Showing the first 500 entries. Narrow down with a folder or search.</p>}
          {pending.length > 0 && (
            <div className="card-pad stack" style={{ gap: 6, borderTop: '1px solid var(--border)' }}>
              <h3>Multipart uploads in progress</h3>
              {pending.map((u) => (
                <div key={u.id} className="row nowrap list-row">
                  <code className="grow ellipsis">{u.key}</code>
                  <span className="row-meta small faint">
                    {u.parts} parts · {fmtBytes(u.bytes)} · {timeAgo(u.createdAt)}
                  </span>
                  <span className="row-actions">
                    <button className="btn xs ghost danger" onClick={() => void bucketAction(() => api.del(`${base}/uploads/${u.id}`), 'Upload aborted')}>
                      Abort
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {newBucket && <NewBucketModal base={base} onClose={() => setNewBucket(false)} onDone={(n) => (setBucketName(n), reload())} />}
      {open && <ObjectDrawer slug={slug} instance={instance} obj={open} onClose={() => setOpen(null)} onDeleted={() => (setOpen(null), reload())} />}
    </div>
  );
}

function NewBucketModal({ base, onClose, onDone }: { base: string; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  const [pub, setPub] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api.post(`${base}/buckets`, { name, public: pub });
      onDone(name);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      title="New bucket"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Create
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <label className="field">
          Name <span className="hint">3–63 characters: lower-case letters, digits, dots, dashes</span>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="uploads" autoFocus />
        </label>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} /> Public (anonymous downloads allowed)
        </label>
      </div>
    </Modal>
  );
}

const isText = (ct: string | null) => /^(text\/|application\/(json|xml|javascript|x-ndjson|csv|yaml))/i.test(ct ?? '');

/** Preview (image, PDF in a sandboxed iframe, text / JSON first 256 KB, audio / video), metadata and actions. */
function ObjectDrawer({ slug, instance, obj, onClose, onDeleted }: { slug: string; instance: StorageInstance; obj: StorageObject; onClose: () => void; onDeleted: () => void }) {
  const copy = useCopy();
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const ct = obj.contentType ?? '';
  useEffect(() => {
    if (!isText(ct) || obj.size === 0) return;
    let live = true;
    void fetch(obj.urls.content, { headers: { range: 'bytes=0-262143' } })
      .then((r) => r.text())
      .then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [obj.urls.content, ct, obj.size]);
  const presign = async (which: 'browser' | 'backend') => {
    try {
      const r = await api.post<{ backend: string; browser: string }>(`${storageBase(slug, instance.slug)}/presign`, { bucket: obj.bucket, key: obj.key, method: 'GET', expiresIn: 3600 });
      copy(r[which], `Presigned ${which} URL copied (1 hour)`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete "${obj.key}"?`)) return;
    await api.del(`${storageBase(slug, instance.slug)}/buckets/${encodeURIComponent(obj.bucket)}/object${qs({ key: obj.key })}`);
    toast('File deleted');
    onDeleted();
  };
  let pretty = text;
  if (text && /json/i.test(ct)) {
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* partial */
    }
  }
  return (
    <Drawer
      title={
        <div style={{ minWidth: 0 }}>
          <div className="ellipsis" style={{ fontWeight: 650 }} title={obj.key}>
            {obj.key.split('/').pop()}
          </div>
          <code className="faint small ellipsis" style={{ display: 'block' }}>
            {obj.bucket}/{obj.key}
          </code>
        </div>
      }
      onClose={onClose}
    >
      <div className="stack">
        <div className="row">
          <a className="btn sm" href={`${obj.urls.content}&download=1`}>
            Download
          </a>
          <button className="btn sm" onClick={() => void presign('browser')}>
            Copy URL (browser)
          </button>
          <button className="btn sm" onClick={() => void presign('backend')}>
            Copy URL (backend)
          </button>
          <button className="btn sm ghost danger" onClick={remove}>
            Delete
          </button>
        </div>
        <div className="file-preview">
          {ct.startsWith('image/') && !ct.includes('svg') ? (
            <img src={obj.urls.content} alt={obj.key} />
          ) : ct === 'application/pdf' || ct.includes('svg') ? (
            <iframe title="preview" sandbox="" src={obj.urls.content} />
          ) : ct.startsWith('video/') ? (
            <video src={obj.urls.content} controls />
          ) : ct.startsWith('audio/') ? (
            <audio src={obj.urls.content} controls />
          ) : isText(ct) ? (
            <pre className="mono">{pretty ?? 'Loading…'}</pre>
          ) : (
            <p className="muted small">No preview for {ct || 'this type'}.</p>
          )}
        </div>
        <dl className="kv wide bare">
          <dt>Size</dt>
          <dd>
            {fmtBytes(obj.size)} ({obj.size.toLocaleString()} bytes){obj.parts ? ` · ${obj.parts} parts` : ''}
          </dd>
          <dt>Type</dt>
          <dd>{ct || '—'}</dd>
          <dt>ETag</dt>
          <dd>
            <code>{obj.etag}</code>
          </dd>
          {Object.entries(obj.checksums)
            .filter(([k]) => k !== 'type')
            .map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <dt>{k.toUpperCase()}</dt>
                <dd>
                  <code>{v}</code>
                </dd>
              </span>
            ))}
          <dt>Modified</dt>
          <dd>{new Date(obj.updatedAt).toLocaleString()}</dd>
          <dt>Source</dt>
          <dd>
            {obj.source}
            {obj.runId ? ' · test run' : ''}
            {obj.acl ? ` · ACL ${obj.acl}` : ''}
          </dd>
          {Object.entries(obj.headers).map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </span>
          ))}
          {Object.entries(obj.metadata).map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <dt>x-amz-meta-{k}</dt>
              <dd>{v}</dd>
            </span>
          ))}
          <dt>Backend URL</dt>
          <dd>
            <code>{obj.urls.backend}</code>
          </dd>
          {obj.logId && (
            <>
              <dt>Upload request</dt>
              <dd>
                <a href={`/traffic?log=${obj.logId}`}>Traffic log entry</a>
              </dd>
            </>
          )}
        </dl>
      </div>
    </Drawer>
  );
}
