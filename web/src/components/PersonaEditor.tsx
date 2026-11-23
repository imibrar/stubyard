import { useEffect, useState } from 'react';
import { api, type Message, type TestUser } from '../api';
import { AIP, type AiProvider } from '../chatApi';
import { useGate } from '../auth';
import { useProject } from '../context';
import { useFetch } from '../hooks';
import { peApi, type Persona, type PersonaInput, type PersonaLimits, type PersonaReference, type PersonaTestResult } from '../personasApi';
import { Badge, CodeBlock, ErrorBox, Modal, useToast } from './ui';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CHANNELS = [
  { id: 'sms', name: 'SMS' },
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'email', name: 'Email' },
];
const LIMIT_FIELDS: { key: Exclude<keyof PersonaLimits, 'endWhenDone'>; label: string; help: string; step?: string }[] = [
  { key: 'maxReplies', label: 'Replies per thread', help: 'The thread ends at this many replies' },
  { key: 'maxTokens', label: 'Tokens per thread', help: 'Input + output tokens of all its model calls' },
  { key: 'maxOutputTokens', label: 'Output tokens per reply', help: 'Passed to the model' },
  { key: 'maxHistory', label: 'History messages', help: 'Messages of the thread sent to the model' },
  { key: 'dailyCalls', label: 'Model calls per day', help: 'All personas of the project, UTC day' },
  { key: 'timeoutMs', label: 'Timeout (ms)', help: 'Per model call' },
  { key: 'temperature', label: 'Temperature', help: '0 to 2', step: '0.1' },
];

/** Goals as text: one per line, "id: text" or just the text (ids g1, g2, … are given by the server). */
const goalsToText = (g: Persona['goals'] | PersonaInput['goals'] | undefined) => (g ?? []).map((x) => (typeof x === 'string' ? x : `${x.id}: ${x.text}`)).join('\n');
const textToGoals = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^([a-z0-9][a-z0-9_-]{0,31}):\s+(.+)$/i.exec(l);
      return m ? { id: m[1], text: m[2] } : l;
    });

/** Short enough for a phone-wide select: "(keyless mock)" only when the label does not already say it is a mock. */
function optionLabel(p: AiProvider): string {
  const label = p.label ?? p.name;
  const suffix = p.mock ? (/mock/i.test(label) ? '' : ' (keyless mock)') : p.hasKey || !p.needsKey ? '' : ' (no key)';
  return label + suffix;
}

/** Model picker: the configured AI providers (/api/system/ai-providers) plus the model list of the chosen one. */
function ModelPicker({ provider, model, onProvider, onModel }: { provider: string; model: string; onProvider: (v: string) => void; onModel: (v: string) => void }) {
  const providers = useFetch<{ providers: AiProvider[] }>(AIP, []);
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    if (!provider) return setModels([]);
    let live = true;
    api
      .get<{ models: { id: string }[] }>(`${AIP}/${encodeURIComponent(provider)}/models`)
      .then((r) => live && setModels(r.models.map((m) => m.id)))
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [provider]);
  const list = (providers.data?.providers ?? []).filter((p) => p.enabled || p.id === provider);
  const chosen = list.find((p) => p.id === provider);
  return (
    <>
      <label className="field">
        Provider
        <select value={provider} onChange={(e) => onProvider(e.target.value)} title={chosen ? optionLabel(chosen) : provider}>
          {!chosen && <option value={provider}>{provider || 'Pick a provider'}</option>}
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {optionLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Model
        <input value={model} onChange={(e) => onModel(e.target.value)} list="pe-models" placeholder="e.g. gpt-5-mini" />
        <datalist id="pe-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
    </>
  );
}

export function PersonaEditor({ initial, reference, onClose, onSaved }: { initial: Persona | PersonaInput; reference: PersonaReference | null; onClose: () => void; onSaved: (p: Persona) => void }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const toast = useToast();
  const saved = 'id' in initial && typeof (initial as Persona).id === 'string' ? (initial as Persona) : null;
  const [name, setName] = useState(initial.name ?? '');
  const [provider, setProvider] = useState(initial.provider ?? 'mock:openai');
  const [model, setModel] = useState(initial.model ?? 'gpt-5-mini');
  const [prompt, setPrompt] = useState(initial.prompt ?? '');
  const [goals, setGoals] = useState(goalsToText(initial.goals));
  const [language, setLanguage] = useState(initial.style?.language ?? '');
  const [tone, setTone] = useState(initial.style?.tone ?? '');
  const [maxChars, setMaxChars] = useState(initial.style?.maxChars ? String(initial.style.maxChars) : '');
  const [limits, setLimits] = useState<Record<string, string>>(() => Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, saved ? String(saved.limits[f.key]) : initial.limits?.[f.key] !== undefined ? String(initial.limits[f.key]) : ''])));
  const [endWhenDone, setEndWhenDone] = useState(initial.limits?.endWhenDone !== false);
  const [fallback, setFallback] = useState(initial.fallback ?? '');
  const [opener, setOpener] = useState(initial.opener ?? '');
  const [enabled, setEnabled] = useState(initial.enabled !== false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isMock = provider.startsWith('mock:');

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const lim: Partial<PersonaLimits> = { endWhenDone };
      for (const f of LIMIT_FIELDS) if (limits[f.key].trim() !== '') lim[f.key] = Number(limits[f.key]);
      const b: PersonaInput = {
        name: name.trim(),
        provider,
        model: model.trim(),
        prompt,
        goals: textToGoals(goals),
        style: { ...(language.trim() ? { language: language.trim() } : {}), ...(tone.trim() ? { tone: tone.trim() } : {}), ...(maxChars.trim() ? { maxChars: Number(maxChars) } : {}) },
        limits: lim,
        fallback: fallback.trim() ? fallback : null,
        opener: opener.trim() ? opener : null,
        enabled,
      };
      const p = saved ? await peApi.update(slug, saved.id, b) : await peApi.create(slug, b);
      toast(saved ? 'Persona saved' : 'Persona created');
      onSaved(p);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={saved ? `Edit persona "${saved.name}"` : 'New persona'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy || !name.trim() || !model.trim() || !!gate.disabled} title={gate.title}>
            {saved ? 'Save' : 'Create persona'}
          </button>
        </>
      }
    >
      <div className="pe-editor stack">
        <ErrorBox error={error} />
        <div className="pe-grid">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Impatient customer" autoFocus />
          </label>
          <ModelPicker provider={provider} model={model} onProvider={setProvider} onModel={setModel} />
        </div>
        {!isMock && provider && (
          <p className="small pe-real-note">
            <Badge kind="warn">real model</Badge> Each reply sends the app's message text, the test user's name, email and phone, and this prompt to <strong>{provider}</strong>. Use <code>mock:openai</code> or <code>mock:anthropic</code> (answered by this project's LLM mocks) for CI.
          </p>
        )}
        <label className="field">
          Who the user is and how they write
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A busy parent who reads messages on the phone. Short replies, sometimes typos. Sends codes back when asked." />
        </label>
        <label className="field">
          Goals <span className="faint">one per line, optionally "id: text"; the model closes them with [[GOAL:id:reached]]</span>
          <textarea rows={3} value={goals} onChange={(e) => setGoals(e.target.value)} placeholder={'code: Get the login code and send it back\nconfirm: Confirm the booking'} />
        </label>
        <fieldset className="ar-fieldset">
          <legend>Style</legend>
          <div className="pe-grid">
            <label className="field">
              Language
              <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="the app's language" />
            </label>
            <label className="field">
              Tone
              <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="e.g. polite, curt" />
            </label>
            <label className="field">
              Max characters
              <input type="number" min={1} max={4000} value={maxChars} onChange={(e) => setMaxChars(e.target.value)} placeholder="SMS 320 · WhatsApp 1000 · email 4000" />
            </label>
          </div>
        </fieldset>
        <fieldset className="ar-fieldset">
          <legend>Limits</legend>
          <div className="pe-grid">
            {LIMIT_FIELDS.map((f) => (
              <label key={f.key} className="field" title={f.help}>
                {f.label}
                <input
                  type="number"
                  min={0}
                  step={f.step ?? '1'}
                  max={reference?.limits.max[f.key]}
                  value={limits[f.key]}
                  placeholder={reference ? String(reference.limits.defaults[f.key]) : ''}
                  onChange={(e) => setLimits((l) => ({ ...l, [f.key]: e.target.value }))}
                />
                <span className="faint pe-help">
                  {f.help}
                  {reference ? `, max ${reference.limits.max[f.key]}` : ''}
                </span>
              </label>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={endWhenDone} onChange={(e) => setEndWhenDone(e.target.checked)} /> End the thread when every goal is closed
          </label>
        </fieldset>
        <div className="pe-grid pe-grid-2">
          <label className="field">
            Fallback <span className="faint">sent once when a limit is reached or the model fails</span>
            <textarea rows={2} value={fallback} onChange={(e) => setFallback(e.target.value)} placeholder="(none: stay silent)" />
          </label>
          <label className="field">
            Opener <span className="faint">first message for "Start conversation"</span>
            <textarea rows={2} value={opener} onChange={(e) => setOpener(e.target.value)} placeholder="Hi, I never got my parcel." />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
      </div>
    </Modal>
  );
}

/** Assign a persona to one test user or a role: creates an auto-reply rule whose reply is the persona. */
export function PersonaAssign({ persona, onClose, onDone }: { persona: Persona; onClose: () => void; onDone: () => void }) {
  const { slug } = useProject();
  const gate = useGate(slug)('walkthroughs.run');
  const toast = useToast();
  const users = useFetch<TestUser[]>(`/api/projects/${encodeURIComponent(slug)}/users`, [slug]);
  const [mode, setMode] = useState<'user' | 'role'>('user');
  const [user, setUser] = useState('');
  const [role, setRole] = useState('customer');
  const [channel, setChannel] = useState('any');
  const [delay, setDelay] = useState('2');
  const [jitter, setJitter] = useState('3');
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const roles = [...new Set((users.data ?? []).map((u) => u.role))];
  const go = async () => {
    setError(null);
    try {
      await peApi.assign(slug, persona.id, {
        ...(mode === 'user' ? { user } : { role }),
        channel,
        delaySeconds: Number(delay || 0),
        jitterSeconds: Number(jitter || 0),
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
      });
      toast('Persona assigned');
      onDone();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Modal
      title={`Assign "${persona.name}"`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void go()} disabled={(mode === 'user' ? !user : !role.trim()) || !!gate.disabled} title={gate.title}>
            Assign
          </button>
        </>
      }
    >
      <div className="pe-editor stack">
        <ErrorBox error={error ?? users.error} />
        <p className="small muted">This adds an auto-reply rule at the top of the list. When the app messages the user, the persona writes the reply.</p>
        <div className="chips" role="group" aria-label="Assign to">
          <button className={`chip ${mode === 'user' ? 'active' : ''}`} onClick={() => setMode('user')}>
            One test user
          </button>
          <button className={`chip ${mode === 'role' ? 'active' : ''}`} onClick={() => setMode('role')}>
            Every user of a role
          </button>
        </div>
        <div className="pe-grid">
          {mode === 'user' ? (
            <label className="field">
              Test user
              <select value={user} onChange={(e) => setUser(e.target.value)}>
                <option value="">Pick a user</option>
                {(users.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              Role
              <input value={role} onChange={(e) => setRole(e.target.value)} list="pe-roles" />
              <datalist id="pe-roles">
                {roles.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
          )}
          <label className="field">
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="any">Any channel</option>
              {CHANNELS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Delay (s)
            <input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} />
          </label>
          <label className="field">
            Jitter (s)
            <input type="number" min={0} value={jitter} onChange={(e) => setJitter(e.target.value)} />
          </label>
        </div>
        <label className="field">
          Extra instruction <span className="faint">optional, for this assignment only</span>
          <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. refuse the first offer" />
        </label>
      </div>
    </Modal>
  );
}

/** Start a conversation: the user sends the opener (or a text) to the app through the provider's inbound webhook. */
export function PersonaStart({ persona, onClose, onDone }: { persona: Persona; onClose: () => void; onDone: (threadId: string) => void }) {
  const { slug } = useProject();
  const gate = useGate(slug)('walkthroughs.run');
  const users = useFetch<TestUser[]>(`/api/projects/${encodeURIComponent(slug)}/users`, [slug]);
  const [user, setUser] = useState('');
  const [channel, setChannel] = useState('sms');
  const [text, setText] = useState(persona.opener ?? '');
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setError(null);
    try {
      const r = await peApi.start(slug, persona.id, { user, channel, ...(text.trim() ? { text } : {}) });
      onDone(r.thread.id);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Modal
      title={`Start a conversation as "${persona.name}"`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void go()} disabled={!user || !text.trim() || !!gate.disabled} title={gate.title}>
            Send
          </button>
        </>
      }
    >
      <div className="pe-editor stack">
        <ErrorBox error={error ?? users.error} />
        <div className="pe-grid">
          <label className="field">
            Test user
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="">Pick a user</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {CHANNELS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          First message
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {!persona.assigned.length && <p className="small ar-warning">⚠ The persona is not assigned to anyone yet: the app's answer will not get a reply. Assign it first.</p>}
      </div>
    </Modal>
  );
}

/** Dry run: what the persona would answer to one of the last messages the app sent. Nothing is sent. */
export function PersonaTryIt({ persona, onClose }: { persona: Persona; onClose: () => void }) {
  const { slug } = useProject();
  const gate = useGate(slug)('walkthroughs.run');
  const msgs = useFetch<Message[]>(`/api/projects/${encodeURIComponent(slug)}/messages?limit=60`, [slug]);
  const outbound = (msgs.data ?? []).filter((m) => m.direction === 'outbound').slice(0, 20);
  const [pick, setPick] = useState('');
  const [channel, setChannel] = useState('sms');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<PersonaTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      setResult(await peApi.test(slug, persona.id, { message: pick ? pick : { channel, body } }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Try "${persona.name}"`} onClose={onClose} wide>
      <div className="pe-editor stack">
        <p className="small muted">
          A dry run: one model call ({persona.mock ? 'answered by this project\'s LLM mocks' : `sent to ${persona.provider}`}), counted against the daily limit. Nothing is sent to the app and no thread is changed.
        </p>
        <label className="field">
          Message the app sent
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Write one below</option>
            {outbound.map((m) => (
              <option key={m.id} value={m.id}>
                [{m.channel}] {(m.subject || m.bodyText || '').slice(0, 90)}
              </option>
            ))}
          </select>
        </label>
        {!pick && (
          <div className="pe-grid pe-grid-try">
            <label className="field">
              Channel
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CHANNELS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Text
              <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Your Shop code is 482913" />
            </label>
          </div>
        )}
        <div className="row">
          <button className="btn primary" onClick={() => void run()} disabled={busy || (!pick && !body.trim()) || !!gate.disabled} title={gate.title}>
            {busy ? 'Asking the model…' : 'Run'}
          </button>
        </div>
        <ErrorBox error={error ?? result?.error} />
        {result && (
          <div className="stack pe-try-result">
            <div>
              <div className="small faint">Reply</div>
              <pre className="ar-pre">{result.reply === null ? '(none)' : result.reply || '(empty: nothing would be sent)'}</pre>
            </div>
            {result.controls.length > 0 && (
              <div className="row pe-chips">
                {result.controls.map((c) => (
                  <code key={c} className="pe-control">
                    {c}
                  </code>
                ))}
              </div>
            )}
            {result.warnings.map((w) => (
              <span key={w} className="small ar-warning">
                ⚠ {w}
              </span>
            ))}
            <p className="small faint">
              {result.usage.inputTokens} in / {result.usage.outputTokens} out tokens · {result.durationMs} ms
            </p>
            <CodeBlock title="System prompt" code={result.system} />
            <CodeBlock title="Messages" code={JSON.stringify(result.messages, null, 2)} lang="json" />
          </div>
        )}
      </div>
    </Modal>
  );
}
