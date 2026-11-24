import { useState } from 'react';
import { api, type LogDetail } from '../api';
import { useGate } from '../auth';
import { useProjects } from '../context';
import { ErrorBox, Modal, useToast } from './ui';

interface ReplayResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  logId: string;
  parentLogId: string;
  resigned: boolean;
}

const SKIP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'accept-encoding', 'x-hub-request-id']);

function headerText(h: Record<string, unknown> | null): string {
  return Object.entries(h ?? {})
    .filter(([k]) => !SKIP.has(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('\n');
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** "Replay" for an HTTP log entry: re-send as captured, or edited, re-signed when it came from a signed template. */
export function ReplayButton({ log, onReplayed }: { log: LogDetail; onReplayed?: (newLogId: string) => void }) {
  const [open, setOpen] = useState(false);
  const { projects } = useProjects();
  const gate = useGate(projects?.find((x) => x.id === log.projectId)?.slug)('walkthroughs.run');
  if (log.protocol !== 'http') return null;
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} disabled={!!gate.disabled} title={gate.title ?? 'Send this request again (optionally edited)'}>
        Replay
      </button>
      {open && <ReplayModal log={log} onClose={() => setOpen(false)} onReplayed={onReplayed} />}
    </>
  );
}

function ReplayModal({ log, onClose, onReplayed }: { log: LogDetail; onClose: () => void; onReplayed?: (id: string) => void }) {
  const toast = useToast();
  const signed = typeof log.resolved.templateId === 'string' && !!log.resolved.signing && log.resolved.signing !== 'none';
  const defaultUrl = log.direction === 'outbound' ? (log.url ?? '') : '';
  const [url, setUrl] = useState(defaultUrl);
  const [method, setMethod] = useState(log.method ?? 'POST');
  const [headers, setHeaders] = useState(headerText(log.reqHeaders));
  const [body, setBody] = useState(log.reqBody ?? '');
  const [resign, setResign] = useState(signed);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);

  const send = async (edited: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { resign };
      if (edited) {
        if (url.trim() && url.trim() !== defaultUrl) payload.url = url.trim();
        if (method !== log.method) payload.method = method;
        const orig = parseHeaders(headerText(log.reqHeaders));
        const next = parseHeaders(headers);
        const diff: Record<string, string | null> = {};
        for (const k of Object.keys(orig)) if (!(k in next)) diff[k] = null;
        for (const [k, v] of Object.entries(next)) if (orig[k] !== v) diff[k] = v;
        if (Object.keys(diff).length) payload.headers = diff;
        if (body !== (log.reqBody ?? '')) payload.body = body;
      }
      const r = await api.post<ReplayResult>(`/api/logs/${log.id}/replay`, payload);
      setResult(r);
      toast(r.ok ? `Replayed: ${r.status}` : `Replay failed: ${r.error ?? r.status}`);
      onReplayed?.(r.logId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Replay request"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={busy} onClick={() => send(false)} title="Send exactly as captured">
            Replay as is
          </button>
          <button className="btn primary" disabled={busy} onClick={() => send(true)}>
            Send edited
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <div className="row nowrap">
          <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: 110 }} aria-label="Method">
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input
            className="mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={log.direction === 'inbound' ? `stubyard ${log.url ?? ''} (same endpoint again)` : 'Target URL'}
            aria-label="URL"
          />
        </div>
        <label className="field">
          Headers <span className="hint">One per line, "Name: value"</span>
          <textarea className="mono" rows={5} value={headers} onChange={(e) => setHeaders(e.target.value)} />
        </label>
        <label className="field">
          Body
          <textarea className="mono" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={resign} disabled={!signed} onChange={(e) => setResign(e.target.checked)} />
          Re-sign with a fresh timestamp
          <span className="faint">{signed ? `(${String(log.resolved.signing)} from template "${String(log.resolved.template)}")` : '(not sent from a signed template)'}</span>
        </label>
        {result && (
          <div className={result.ok ? 'info-box' : 'error-box'}>
            {result.ok ? `Answered ${result.status}` : `Failed: ${result.error ?? result.status}`}
            {result.resigned && ' · re-signed'} · new log <code>{result.logId}</code> (linked to <code>{result.parentLogId}</code>)
          </div>
        )}
      </div>
    </Modal>
  );
}
