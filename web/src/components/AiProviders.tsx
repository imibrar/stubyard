import { useState } from 'react';
import { api } from '../api';
import { AIP, type AiPreset, type AiProvider } from '../chatApi';
import { useFetch } from '../hooks';
import { Menu } from './people';
import { Badge, ErrorBox, Modal, useToast } from './ui';

/** System → AI providers: keys are write-only (only "••••1234" comes back); env-var providers are read-only. */
export default function AiProviders() {
  const r = useFetch<{ providers: AiProvider[]; presets: AiPreset[] }>(AIP);
  const toast = useToast();
  const [editing, setEditing] = useState<{ provider: AiProvider | null; preset: AiPreset | null } | null>(null);
  const [testing, setTesting] = useState<AiProvider | null>(null);
  const presets = r.data?.presets ?? [];
  const presetOf = (p: AiProvider) => presets.find((x) => x.kind === p.kind && (x.preset ?? null) === (p.preset ?? null)) ?? null;

  const remove = async (p: AiProvider) => {
    if (!confirm(`Delete the AI provider “${p.name}” and its stored key? Agents that use it stop working.`)) return;
    try {
      await api.del(`${AIP}/${encodeURIComponent(p.id)}`);
      void r.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const toggle = async (p: AiProvider) => {
    try {
      await api.patch(`${AIP}/${encodeURIComponent(p.id)}`, { enabled: !p.enabled });
      void r.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="card stack aip-card">
      <div className="card-head">
        <h2 className="grow">AI providers</h2>
        <Menu floating className="btn sm primary" label="Add…">
          {(close) =>
            presets.map((x) => (
              <button key={x.id} onClick={() => (close(), setEditing({ provider: null, preset: x }))}>
                {x.label}
                <span className="sub">{x.kind}</span>
              </button>
            ))
          }
        </Menu>
      </div>
      <p className="muted small aip-intro">
        Used by the project Chat pages. Keys are stored in devhub’s database, never shown again and never exported; environment variables (
        <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, <code>GOOGLE_GENERATIVE_AI_API_KEY</code>, <code>OPENROUTER_API_KEY</code>,{' '}
        <code>DEVHUB_OLLAMA_URL</code>) win over stored keys. Requests only go to the provider’s base URL host.
      </p>
      <ErrorBox error={r.error} />
      <div className="table-wrap aip-cq">
        <table className="aip-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="aip-col-url">Base URL</th>
              <th>Key</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(r.data?.providers ?? []).map((p) => (
              <tr key={p.id} className={p.enabled ? '' : 'aip-off'}>
                <td>
                  <div className="row aip-name">
                    <b>{p.name}</b>
                    {p.env && <Badge kind="accent">env</Badge>}
                    {!p.enabled && <Badge>off</Badge>}
                  </div>
                  <div className="small faint">{p.preset ?? p.kind}</div>
                  <div className="small faint mono aip-url-inline">{p.effectiveBaseUrl}</div>
                </td>
                <td className="mono small aip-url aip-col-url">{p.effectiveBaseUrl}</td>
                <td className="small nowrap">
                  {p.hasKey ? (
                    <>
                      <span className="mono">{p.keyHint}</span> <span className="faint">{p.source === 'env' ? `from ${p.envVar}` : 'stored'}</span>
                    </>
                  ) : p.needsKey ? (
                    <Badge kind="warn">no key</Badge>
                  ) : (
                    <span className="faint">not needed</span>
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn xs" onClick={() => setTesting(p)}>
                      Test
                    </button>
                    {!p.env && (
                      <Menu floating className="btn xs ghost" label={<span aria-label={`${p.name} actions`}>⋯</span>}>
                        {(close) => (
                          <>
                            <button onClick={() => (close(), setEditing({ provider: p, preset: presetOf(p) }))}>Edit…</button>
                            <button onClick={() => (close(), void toggle(p))}>{p.enabled ? 'Disable' : 'Enable'}</button>
                            <button onClick={() => (close(), void remove(p))}>Delete</button>
                          </>
                        )}
                      </Menu>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {r.data && !r.data.providers.length && (
              <tr>
                <td colSpan={4} className="small faint">
                  None yet. Add one, or start devhub with e.g. <code>OPENAI_API_KEY</code> set.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && <ProviderEditor {...editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void r.reload())} />}
      {testing && <ProviderTest provider={testing} hint={presetOf(testing)?.modelHint ?? ''} onClose={() => setTesting(null)} />}
    </div>
  );
}

const hostOf = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
};

function ProviderEditor({ provider, preset, onClose, onSaved }: { provider: AiProvider | null; preset: AiPreset | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(provider?.name ?? preset?.id ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = provider?.kind ?? preset?.kind ?? 'openai';
  const needsUrl = (provider?.preset ?? preset?.preset) === 'custom';
  // The server clears the stored key and header values when the host it calls changes (unless a key comes with the save).
  const oldHost = provider ? hostOf(provider.effectiveBaseUrl) : null;
  const newHost = baseUrl.trim() ? hostOf(baseUrl.trim()) : provider?.baseUrl ? hostOf(preset?.baseUrl ?? null) : oldHost;
  const hasSecrets = !!provider && ((provider.hasKey && provider.source === 'stored') || Object.keys(provider.headers ?? {}).length > 0);
  const hostChanges = hasSecrets && newHost !== oldHost;

  const save = async () => {
    setError(null);
    const body: Record<string, unknown> = { name, baseUrl: baseUrl.trim() || null };
    if (apiKey) body.apiKey = apiKey;
    else if (clearKey) body.apiKey = '';
    try {
      if (provider) await api.patch(`${AIP}/${encodeURIComponent(provider.id)}`, body);
      else await api.post(AIP, { ...body, kind, preset: preset?.preset ?? undefined });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={provider ? `Edit ${provider.name}` : `Add ${preset?.label ?? 'provider'}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || (needsUrl && !baseUrl.trim())} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void save())} autoComplete="off">
        <ErrorBox error={error} />
        <label className="field">
          Name <span className="hint">agents refer to it by this name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field">
          Base URL {needsUrl ? '' : <span className="hint">empty = {provider?.effectiveBaseUrl ?? preset?.baseUrl}</span>}
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={needsUrl ? 'http://host.docker.internal:1234/v1' : (preset?.baseUrl ?? provider?.effectiveBaseUrl ?? '')} className="mono" />
        </label>
        <label className="field">
          API key{' '}
          <span className="hint">
            write-only{provider?.hasKey && provider.source === 'stored' ? ` · leave empty to keep ${provider.keyHint}` : ''}
            {preset?.envVar ? ` · or set ${preset.envVar}` : ''}
          </span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider?.hasKey ? '••••••••' : (preset?.needsKey ?? true) ? 'sk-…' : 'not needed'} autoComplete="new-password" className="mono" />
        </label>
        {hostChanges && (
          <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
            The host changes{newHost ? ` to ${newHost}` : ''}: the stored key{Object.keys(provider?.headers ?? {}).length ? ' and header values' : ''} will be cleared — enter the key again above to keep one.
          </p>
        )}
        {provider?.hasKey && provider.source === 'stored' && !hostChanges && (
          <label className="chat-check small">
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove the stored key
          </label>
        )}
        {provider?.source === 'env' && <p className="small muted" style={{ margin: 0 }}>The key comes from {provider.envVar}, which wins over a stored key.</p>}
      </form>
    </Modal>
  );
}

function ProviderTest({ provider, hint, onClose }: { provider: AiProvider; hint: string; onClose: () => void }) {
  const [model, setModel] = useState(hint);
  const [models, setModels] = useState<string[] | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text?: string; error?: string; usage?: { inputTokens: number; outputTokens: number }; durationMs?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = encodeURIComponent(provider.id);

  const test = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.post(`${AIP}/${id}/test`, { model }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const list = async () => {
    setError(null);
    try {
      const r = await api.get<{ models: { id: string }[] }>(`${AIP}/${id}/models`);
      setModels(r.models.map((m) => m.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`Test ${provider.name}`} onClose={onClose}>
      <div className="form">
        <p className="small muted" style={{ margin: 0 }}>
          Sends one short prompt (“Reply with the single word OK.”) to <span className="mono">{provider.effectiveBaseUrl}</span>.
        </p>
        <label className="field">
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} list="aip-models" className="mono" />
          <datalist id="aip-models">
            {(models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <div className="row">
          <button className="btn primary" disabled={busy || !model.trim()} onClick={() => void test()}>
            {busy ? 'Testing…' : 'Send test prompt'}
          </button>
          <button className="btn" onClick={() => void list()}>
            List models
          </button>
        </div>
        <ErrorBox error={error ?? (result && !result.ok ? (result.error ?? 'failed') : null)} />
        {result?.ok && (
          <div className="small">
            <Badge kind="ok">OK</Badge> “{result.text}” · {result.usage?.inputTokens ?? '—'} / {result.usage?.outputTokens ?? '—'} tokens
            {result.durationMs !== undefined && ` · ${(result.durationMs / 1000).toFixed(1)} s`}
          </div>
        )}
        {models && <div className="small faint">{models.length ? `${models.length} models: ${models.slice(0, 30).join(', ')}${models.length > 30 ? '…' : ''}` : 'No models listed.'}</div>}
      </div>
    </Modal>
  );
}
