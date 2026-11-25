import { useState } from 'react';
import { api } from '../api';
import { useGate } from '../auth';
import { useFetch, useHubEvents } from '../hooks';
import { Badge, ErrorBox, useToast } from './ui';

/** A WhatsApp message template of one provider instance (server: wa_templates). */
interface WaTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  reason: string | null;
  quality: string;
  createdAt: string;
}

const STATUS_KIND: Record<string, string> = { APPROVED: 'ok', PENDING: 'warn', REJECTED: 'bad', PAUSED: 'warn', DISABLED: 'bad' };
const QUALITY_KIND: Record<string, string> = { GREEN: 'ok', YELLOW: 'warn', RED: 'bad' };

/**
 * WhatsApp instances: templates the app created through the vendor API (or here), with approve / reject / pause.
 * Each change sends the vendor's template status webhook to the instance's webhook URL.
 */
export function WaTemplatesCard({ slug, instance }: { slug: string; instance: string }) {
  const gate = useGate(slug)('project.providers');
  const toast = useToast();
  const base = `/api/projects/${slug}/providers/${instance}/templates`;
  const list = useFetch<WaTemplate[]>(base, [base]);
  useHubEvents(slug, (e) => {
    if (e.type === 'provider.changed') void list.reload();
  });
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [category, setCategory] = useState('UTILITY');
  const [body, setBody] = useState('');

  const create = async () => {
    try {
      await api.post(base, { name: name.trim(), language: language.trim(), category, body: body.trim() || name.trim() });
      toast(`Template ${name.trim()} created (PENDING)`);
      setName('');
      setBody('');
      void list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const change = async (t: WaTemplate, patch: Record<string, string>, label: string) => {
    try {
      const r = await api.patch<{ webhooks: { ok: boolean; status: number | null }[] }>(`${base}/${t.id}`, patch);
      const w = r.webhooks[0];
      toast(`${t.name}: ${label}${w ? (w.ok ? ' · webhook sent' : ` · webhook failed (${w.status ?? 'no answer'})`) : ''}`);
      void list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async (t: WaTemplate) => {
    if (!confirm(`Delete template "${t.name}" (${t.language})?`)) return;
    try {
      await api.del(`${base}/${t.id}`);
      void list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const items = list.data ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h3>Templates</h3>
        <span className="faint small">{items.length ? `${items.length} template${items.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="card-pad stack">
        <p className="small faint" style={{ margin: 0 }}>
          Templates your app creates through the vendor API land here as PENDING. Approve or reject them to send the template status webhook; sending a template that is not approved
          fails with the vendor&apos;s error (Meta 132001). Review settings are under Settings.
        </p>
        <ErrorBox error={list.error} />
        {items.map((t) => (
          <div key={t.id} className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ minWidth: 0 }}>
              <code>{t.name}</code>
              <span className="faint small">
                {t.language} · {t.category.toLowerCase()}
              </span>
              <Badge kind={STATUS_KIND[t.status]} title={t.reason && t.status === 'REJECTED' ? `Reason: ${t.reason}` : undefined}>
                {t.status.toLowerCase()}
              </Badge>
              {t.quality !== 'UNKNOWN' && <Badge kind={QUALITY_KIND[t.quality]}>quality {t.quality.toLowerCase()}</Badge>}
            </div>
            <div className="row-actions">
              {t.status !== 'APPROVED' && (
                <button className="btn sm" onClick={() => void change(t, { status: 'APPROVED' }, 'approved')} {...gate}>
                  Approve
                </button>
              )}
              {t.status !== 'REJECTED' && (
                <button className="btn sm" onClick={() => void change(t, { status: 'REJECTED', reason: 'INVALID_FORMAT' }, 'rejected')} {...gate}>
                  Reject
                </button>
              )}
              {t.status === 'APPROVED' && (
                <button className="btn sm ghost" onClick={() => void change(t, { status: 'PAUSED', quality: 'RED' }, 'paused (quality red)')} {...gate}>
                  Pause
                </button>
              )}
              <button className="btn sm ghost danger" onClick={() => void remove(t)} {...gate}>
                Delete
              </button>
            </div>
          </div>
        ))}
        {list.data && !items.length && <p className="muted small">No templates yet.</p>}
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="template_name" aria-label="Template name" style={{ flex: '1 1 140px' }} />
          <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en_US" aria-label="Language" style={{ width: 80 }} />
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="UTILITY">Utility</option>
            <option value="MARKETING">Marketing</option>
            <option value="AUTHENTICATION">Authentication</option>
          </select>
          <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Body text, e.g. Order {{1}} shipped" aria-label="Body" style={{ flex: '2 1 200px' }} />
          <button className="btn sm" disabled={!name.trim() || !!gate.disabled} title={gate.title} onClick={() => void create()}>
            Add template
          </button>
        </div>
      </div>
    </div>
  );
}
