import { createContext, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { TestUser } from '../api';
import {
  sbApi,
  issuesOf,
  STEP_KIND_HELP,
  STEP_KIND_LABEL,
  STEP_KINDS,
  toStoryboardInput,
  type Actor,
  type Input,
  type RunMode,
  type RecordMode,
  type Step,
  type StepKind,
  type Storyboard,
  type StoryboardView,
  type ValidationIssue,
  type ValidationResult,
} from '../storyboardsApi';
import { Icon, Menu } from './people';
import { Badge, ErrorBox, useCopy, useToast } from './ui';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// =====================================================================================================================
// Shared bits (also used by DataSetEditor and LoginRecipes)

export interface Issues {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Issues whose path is exactly `path`. */
export function issuesAt(issues: Issues | null | undefined, path: string): (ValidationIssue & { level: 'error' | 'warning' })[] {
  if (!issues) return [];
  return [
    ...issues.errors.filter((i) => i.path === path).map((i) => ({ ...i, level: 'error' as const })),
    ...issues.warnings.filter((i) => i.path === path).map((i) => ({ ...i, level: 'warning' as const })),
  ];
}

/** Issues under `prefix` (the path itself, `prefix.x` or `prefix[n]…`). */
export function issuesUnder(issues: Issues | null | undefined, prefix: string): { errors: number; warnings: number } {
  if (!issues) return { errors: 0, warnings: 0 };
  const m = (p: string) => p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`);
  return { errors: issues.errors.filter((i) => m(i.path)).length, warnings: issues.warnings.filter((i) => m(i.path)).length };
}

export function IssueNotes({ issues, path }: { issues: Issues | null | undefined; path: string }) {
  const list = issuesAt(issues, path);
  if (!list.length) return null;
  return (
    <span className="sb-field-issues">
      {list.map((i, n) => (
        <span key={n} className={`sb-issue-note ${i.level}`}>
          {i.level === 'error' ? '✕' : '⚠'} {i.message}
          {i.expected?.length ? <span className="faint"> (expected: {i.expected.join(', ')})</span> : null}
        </span>
      ))}
    </span>
  );
}

/** A labelled field with the issues of its path below it. */
export function Field({ label, hint, path, issues, children, wide }: { label: ReactNode; hint?: ReactNode; path?: string; issues?: Issues | null; children: ReactNode; wide?: boolean }) {
  const bad = path ? issuesAt(issues, path) : [];
  return (
    <div className={`field sb-field ${wide ? 'wide' : ''} ${bad.some((i) => i.level === 'error') ? 'has-error' : bad.length ? 'has-warning' : ''}`}>
      <span className="field-label">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
      {children}
      {path && <IssueNotes issues={issues} path={path} />}
    </div>
  );
}

/** The validation list: every issue with its path, clickable to jump to the field. */
export function IssueList({ issues, onPick, okText = 'No problems found.' }: { issues: Issues | null; onPick?: (path: string) => void; okText?: string }) {
  if (!issues) return <p className="muted small">Checking…</p>;
  if (!issues.errors.length && !issues.warnings.length) return <p className="small sb-ok">✓ {okText}</p>;
  const row = (i: ValidationIssue, level: 'error' | 'warning', n: number) => (
    <li key={`${level}${n}`}>
      <button type="button" className={`sb-issue ${level}`} onClick={() => onPick?.(i.path)} disabled={!onPick}>
        <span className="sb-issue-head">
          <Badge kind={level === 'error' ? 'bad' : 'warn'}>{level === 'error' ? 'error' : 'warning'}</Badge>
          <code className="sb-issue-path">{i.path || '(root)'}</code>
          <span className="faint small">{i.code}</span>
        </span>
        <span className="sb-issue-msg">{i.message}</span>
        {i.expected?.length ? <span className="faint small">Expected: {i.expected.join(', ')}</span> : null}
      </button>
    </li>
  );
  return (
    <ul className="sb-issues">
      {issues.errors.map((i, n) => row(i, 'error', n))}
      {issues.warnings.map((i, n) => row(i, 'warning', n))}
    </ul>
  );
}

/** Jump to the input with data-path=path (or the closest container) and focus it. */
export function focusPath(path: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus({ preventScroll: true });
    }
  });
}

// ---------- template inputs + variable picker ----------

interface Target {
  el: HTMLInputElement | HTMLTextAreaElement;
  set: (v: string) => void;
}
const TplCtx = createContext<{ current: Target | null } | null>(null);

/** A text input (or textarea) that the "Insert variable" menu can write into. Empty → onChange(''). */
export function Tpl({ value, onChange, path, placeholder, multiline, mono = true, ariaLabel }: { value: string | undefined; onChange: (v: string) => void; path?: string; placeholder?: string; multiline?: boolean; mono?: boolean; ariaLabel?: string }) {
  const ctx = useContext(TplCtx);
  const set = useRef(onChange);
  set.current = onChange;
  const onFocus = (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    if (ctx) ctx.current = { el: e.currentTarget, set: (v) => set.current(v) };
  };
  const common = { value: value ?? '', placeholder, 'data-path': path, 'aria-label': ariaLabel, onFocus, className: mono ? 'mono' : undefined };
  return multiline ? <textarea rows={2} {...common} onChange={(e) => onChange(e.target.value)} /> : <input {...common} onChange={(e) => onChange(e.target.value)} />;
}

export function TplProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Target | null>(null);
  return <TplCtx.Provider value={ref}>{children}</TplCtx.Provider>;
}

export function VariablePicker({ variables }: { variables: { name: string; help: string }[] }) {
  const ctx = useContext(TplCtx);
  const copy = useCopy();
  const [q, setQ] = useState('');
  const insert = (name: string) => {
    const text = `{{${name}}}`;
    const t = ctx?.current;
    if (!t || !document.body.contains(t.el)) return void copy(text, `Copied ${text}`);
    const start = t.el.selectionStart ?? t.el.value.length;
    const end = t.el.selectionEnd ?? start;
    const next = t.el.value.slice(0, start) + text + t.el.value.slice(end);
    t.set(next);
    requestAnimationFrame(() => {
      t.el.focus();
      t.el.setSelectionRange(start + text.length, start + text.length);
    });
  };
  const shown = variables.filter((v) => !q || v.name.includes(q) || v.help.toLowerCase().includes(q.toLowerCase()));
  return (
    <Menu label={<>{'{{ }}'} Variables</>} className="btn sm" floating menuClassName="sb-var-menu" title="Insert a template variable into the last focused field">
      {(close) => (
        <>
          <input className="sb-var-search" placeholder="Filter variables" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Filter variables" />
          <div className="sb-var-list">
            {shown.map((v) => (
              <button key={v.name} onClick={() => (close(), insert(v.name))} title={v.help}>
                <code>{`{{${v.name}}}`}</code>
                <span className="faint small">{v.help}</span>
              </button>
            ))}
            {!shown.length && <p className="faint small" style={{ padding: 8, margin: 0 }}>No match</p>}
          </div>
        </>
      )}
    </Menu>
  );
}

// =====================================================================================================================
// Storyboard editor

const OPTIONAL_OBJECTS = new Set(['link', 'assert', 'target']);
/** Fields kept even when empty (so validation reports them as "required" at their path). */
const KEEP_EMPTY = new Set(['title', 'intent']);

/** Set a step field; '' / undefined deletes it (except title/intent). */
function patchStep(s: Step, patch: Partial<Record<keyof Step, unknown>>): Step {
  const n = { ...s } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if ((v === '' || v === undefined) && !KEEP_EMPTY.has(k)) delete n[k];
    else n[k] = v;
  }
  return n as unknown as Step;
}

function patchNested(s: Step, key: 'match' | 'link' | 'assert' | 'target', field: string, v: unknown): Step {
  const obj = { ...((s[key] as Record<string, unknown> | undefined) ?? {}) };
  if (v === '' || v === undefined) delete obj[field];
  else obj[field] = v;
  const n = { ...s } as Record<string, unknown>;
  if (!Object.keys(obj).length && OPTIONAL_OBJECTS.has(key)) delete n[key];
  else n[key] = obj;
  return n as unknown as Step;
}

function nextStepId(steps: Step[]): string {
  const taken = new Set(steps.map((s) => s.id).filter(Boolean));
  let n = steps.length + 1;
  while (taken.has(`s${n}`)) n++;
  return `s${n}`;
}

/** Fields of each kind (beyond the base ones); changing the kind drops the others. */
const KIND_FIELDS: Record<StepKind, (keyof Step)[]> = {
  open: ['url'],
  login: ['recipe', 'url'],
  logout: ['url'],
  fill: ['dataSet', 'url', 'formId'],
  email: ['channel', 'match', 'link', 'timeoutSec', 'open'],
  instruction: [],
  capture: ['var', 'selector', 'attribute', 'textPattern', 'required'],
  check: ['expect', 'assert'],
};
const ALL_KIND_FIELDS = [...new Set(Object.values(KIND_FIELDS).flat())];

function newStep(kind: StepKind, steps: Step[], actors: Actor[]): Step {
  const s: Step = { id: nextStepId(steps), kind, title: '', intent: '' };
  if (kind === 'open') s.url = '/';
  if (kind === 'login' || kind === 'email') s.actor = steps.findLast((x) => x.actor)?.actor ?? actors[0]?.key;
  if (kind === 'email') {
    s.channel = 'email';
    s.match = {};
    s.timeoutSec = 120;
    s.open = 'same-tab';
  }
  if (kind === 'fill') s.dataSet = '';
  if (kind === 'capture') {
    s.var = '';
    s.required = true;
  }
  if (kind === 'check') s.expect = '';
  return s;
}

function changeKind(s: Step, kind: StepKind, steps: Step[], actors: Actor[]): Step {
  const base = { ...s } as Record<string, unknown>;
  for (const k of ALL_KIND_FIELDS) delete base[k];
  const fresh = newStep(kind, steps, actors) as unknown as Record<string, unknown>;
  for (const k of KIND_FIELDS[kind]) if (fresh[k] !== undefined) base[k] = fresh[k];
  if ((kind === 'login' || kind === 'email') && !base.actor) base.actor = fresh.actor;
  base.kind = kind;
  return base as unknown as Step;
}

export interface EditorContext {
  slug: string;
  users: TestUser[];
  roles: string[];
  dataSets: string[];
  recipes: string[];
  variables: { name: string; help: string }[];
}

/** The storyboard editor: header, actors, inputs, ordered steps, live validation, JSON mode. */
export function StoryboardEditor({
  initial,
  existing,
  ctx,
  onClose,
  onSaved,
  onDeleted,
  onDuplicated,
}: {
  initial: Storyboard;
  existing: StoryboardView | null;
  ctx: EditorContext;
  onClose: () => void;
  onSaved: (v: StoryboardView) => void;
  onDeleted: () => void;
  onDuplicated: (v: StoryboardView) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Storyboard>(initial);
  const [saved, setSaved] = useState(() => JSON.stringify(initial));
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [saveIssues, setSaveIssues] = useState<Issues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openSteps, setOpenSteps] = useState<Set<string>>(() => new Set(initial.steps.length <= 3 ? initial.steps.map((s) => s.id ?? '') : []));
  const dragIdx = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const isNew = !existing;
  const dirty = JSON.stringify(draft) !== saved;

  // Live validation (500 ms debounce). The server validates the draft as is, so paths index the draft arrays.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      sbApi
        .validate(ctx.slug, draft)
        .then((r) => live && (setValidation(r), setSaveIssues(null)))
        .catch((e) => live && setError(errText(e)));
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [draft, ctx.slug]);

  const issues: Issues | null = saveIssues ?? validation;

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [dirty]);

  const set = (patch: Partial<Storyboard>) => setDraft((d) => ({ ...d, ...patch }));
  const setStep = (i: number, s: Step) => setDraft((d) => ({ ...d, steps: d.steps.map((x, j) => (j === i ? s : x)) }));
  const moveStep = (from: number, to: number) =>
    setDraft((d) => {
      if (to < 0 || to >= d.steps.length || from === to) return d;
      const steps = [...d.steps];
      const [s] = steps.splice(from, 1);
      steps.splice(to, 0, s);
      return { ...d, steps };
    });
  const removeStep = (i: number) => setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }));
  const addStep = (kind: StepKind, at?: number) => {
    const s = newStep(kind, draft.steps, draft.actors);
    setDraft((d) => {
      const steps = [...d.steps];
      steps.splice(at ?? steps.length, 0, s);
      return { ...d, steps };
    });
    setOpenSteps((o) => new Set(o).add(s.id!));
    focusPath(`steps[${at ?? draft.steps.length}].title`);
  };
  const duplicateStep = (i: number) => {
    const src = draft.steps[i];
    const copy = { ...structuredClone(src), id: nextStepId(draft.steps), title: `${src.title} (copy)` };
    setDraft((d) => {
      const steps = [...d.steps];
      steps.splice(i + 1, 0, copy);
      return { ...d, steps };
    });
    setOpenSteps((o) => new Set(o).add(copy.id));
  };
  const toggle = (id: string) =>
    setOpenSteps((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const pick = (path: string) => {
    if (mode === 'json') setMode('form');
    const m = /^steps\[(\d+)\]/.exec(path);
    if (m) {
      const s = draft.steps[Number(m[1])];
      if (s?.id) setOpenSteps((o) => new Set(o).add(s.id!));
    }
    // Focus the exact field, else the closest parent path that has one.
    requestAnimationFrame(() => {
      let p = path;
      while (p) {
        if (document.querySelector(`[data-path="${CSS.escape(p)}"]`)) return focusPath(p);
        const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('['));
        p = cut > 0 ? p.slice(0, cut) : '';
      }
      const step = m ? document.getElementById(`sb-step-${m[1]}`) : null;
      step?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  const switchMode = (m: 'form' | 'json') => {
    if (m === 'json') {
      setJsonText(JSON.stringify(draft, null, 2));
      setJsonError(null);
    }
    setMode(m);
  };
  const onJson = (text: string) => {
    setJsonText(text);
    try {
      const v = JSON.parse(text) as Storyboard;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The storyboard must be a JSON object');
      setDraft({ ...v, actors: Array.isArray(v.actors) ? v.actors : [], steps: Array.isArray(v.steps) ? v.steps : [] });
      setJsonError(null);
    } catch (e) {
      setJsonError(errText(e));
    }
  };

  const save = async () => {
    setError(null);
    const key = isNew ? draft.slug : existing!.slug;
    if (!key) return setError('Give the storyboard a slug first.');
    setBusy(true);
    try {
      const v = await sbApi.putStoryboard(ctx.slug, key, { ...draft, slug: key });
      const next = toStoryboardInput(v);
      setDraft(next);
      setSaved(JSON.stringify(next));
      setSaveIssues(null);
      toast(`Saved "${v.name}" (v${v.version})${v.warnings.length ? ` with ${v.warnings.length} warning${v.warnings.length === 1 ? '' : 's'}` : ''}`);
      onSaved(v);
    } catch (e) {
      const iss = issuesOf(e);
      if (iss) setSaveIssues(iss);
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!existing || !confirm(`Delete storyboard "${existing.name}"? Walkthroughs keep their copy of the steps.`)) return;
    try {
      await sbApi.deleteStoryboard(ctx.slug, existing.slug);
      toast('Storyboard deleted');
      onDeleted();
    } catch (e) {
      setError(errText(e));
    }
  };
  const duplicate = async () => {
    if (!existing) return;
    const to = prompt('Slug of the copy (lowercase letters, digits, dashes)', `${existing.slug}-copy`);
    if (!to) return;
    try {
      const v = await sbApi.duplicate(ctx.slug, existing.slug, { slug: to.trim(), name: `${existing.name} (copy)` });
      toast(`Duplicated as ${v.slug}`);
      onDuplicated(v);
    } catch (e) {
      setError(errText(e));
    }
  };
  const close = () => {
    if (dirty && !confirm('Discard the unsaved changes?')) return;
    onClose();
  };

  const counts = issues ? { e: issues.errors.length, w: issues.warnings.length } : null;
  const actorKeys = draft.actors.map((a) => a.key).filter(Boolean);

  return (
    <TplProvider>
      <div className="sb-editor-wrap">
        <div className="card sb-editor-bar">
          <button className="btn sm ghost" onClick={close}>
            ← Storyboards
          </button>
          <div className="grow sb-editor-title">
            <strong className="ellipsis">{draft.name || (isNew ? 'New storyboard' : existing!.name)}</strong>
            {existing && <span className="faint small">v{existing.version}</span>}
            {dirty && <Badge kind="warn">unsaved</Badge>}
            {counts && counts.e > 0 && <Badge kind="bad">{counts.e} error{counts.e === 1 ? '' : 's'}</Badge>}
            {counts && counts.w > 0 && <Badge kind="warn">{counts.w} warning{counts.w === 1 ? '' : 's'}</Badge>}
          </div>
          <div className="row sb-editor-actions">
            <div className="sb-seg" role="tablist" aria-label="Editor mode">
              <button role="tab" aria-selected={mode === 'form'} className={mode === 'form' ? 'active' : ''} onClick={() => switchMode('form')}>
                Form
              </button>
              <button role="tab" aria-selected={mode === 'json'} className={mode === 'json' ? 'active' : ''} onClick={() => switchMode('json')}>
                JSON
              </button>
            </div>
            {mode === 'form' && <VariablePicker variables={ctx.variables} />}
            {existing && (
              <Menu label={<span aria-label="More actions">⋯</span>} className="btn sm" floating>
                {(c) => (
                  <>
                    <button onClick={() => (c(), void duplicate())}>Duplicate…</button>
                    <button onClick={() => (c(), void remove())}>Delete</button>
                  </>
                )}
              </Menu>
            )}
            <button className="btn sm primary" onClick={() => void save()} disabled={busy || (mode === 'json' && !!jsonError)}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <ErrorBox error={error} />

        <div className="sb-editor">
          <div className="sb-editor-main stack">
            {mode === 'json' ? (
              <div className="card card-pad stack">
                <p className="muted small" style={{ margin: 0 }}>
                  The storyboard as JSON (the shape of <code>PUT /storyboards/:slug</code>). Valid JSON is applied as you type; Save stores it.
                </p>
                <ErrorBox error={jsonError} />
                <textarea className="mono sb-json" value={jsonText} onChange={(e) => onJson(e.target.value)} spellCheck={false} aria-label="Storyboard JSON" />
              </div>
            ) : (
              <>
                <HeaderCard draft={draft} set={set} isNew={isNew} issues={issues} />
                <ActorsCard draft={draft} set={set} issues={issues} ctx={ctx} />
                <InputsCard draft={draft} set={set} issues={issues} />
                <div className="card">
                  <div className="card-head">
                    <h3>
                      Steps <span className="faint small">({draft.steps.length})</span>
                    </h3>
                    <div className="row">
                      {draft.steps.length > 0 && (
                        <button className="btn sm ghost" onClick={() => setOpenSteps(openSteps.size ? new Set() : new Set(draft.steps.map((s) => s.id ?? '')))}>
                          {openSteps.size ? 'Collapse all' : 'Expand all'}
                        </button>
                      )}
                      <AddStepMenu onAdd={(k) => addStep(k)} primary />
                    </div>
                  </div>
                  <IssueNotes issues={issues} path="steps" />
                  {!draft.steps.length && (
                    <p className="muted small card-pad" style={{ margin: 0 }}>
                      No steps yet. A storyboard needs at least one: start with "Open page" or "Log in".
                    </p>
                  )}
                  <ol className="sb-steps">
                    {draft.steps.map((s, i) => {
                      const id = s.id ?? `#${i}`;
                      const open = openSteps.has(id);
                      const n = issuesUnder(issues, `steps[${i}]`);
                      return (
                        <li
                          key={id}
                          id={`sb-step-${i}`}
                          className={`sb-step ${open ? 'open' : ''} ${dragOver === i ? 'drag-over' : ''}`}
                          onDragOver={(e) => (e.preventDefault(), setDragOver(i))}
                          onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
                          onDrop={(e: DragEvent) => {
                            e.preventDefault();
                            setDragOver(null);
                            if (dragIdx.current !== null) moveStep(dragIdx.current, i);
                            dragIdx.current = null;
                          }}
                        >
                          <div className="sb-step-head">
                            <span
                              className="sb-grip"
                              draggable
                              onDragStart={(e) => ((dragIdx.current = i), e.dataTransfer.setData('text/plain', String(i)), (e.dataTransfer.effectAllowed = 'move'))}
                              title="Drag to reorder"
                              aria-hidden
                            >
                              ⋮⋮
                            </span>
                            <button className="sb-step-toggle" onClick={() => toggle(id)} aria-expanded={open}>
                              <span className="sb-step-pos">{i + 1}</span>
                              <span className={`sb-kind k-${s.kind}`}>{STEP_KIND_LABEL[s.kind] ?? s.kind}</span>
                              <span className="sb-step-title ellipsis">{s.title || <span className="faint">Untitled step</span>}</span>
                              {s.optional && <Badge>optional</Badge>}
                              {n.errors > 0 && <Badge kind="bad">{n.errors}</Badge>}
                              {n.warnings > 0 && <Badge kind="warn">{n.warnings}</Badge>}
                              <span className="faint small sb-step-id">{s.id}</span>
                            </button>
                            <div className="sb-step-actions">
                              <button className="icon-btn" disabled={i === 0} onClick={() => moveStep(i, i - 1)} aria-label={`Move step ${i + 1} up`}>
                                ↑
                              </button>
                              <button className="icon-btn" disabled={i === draft.steps.length - 1} onClick={() => moveStep(i, i + 1)} aria-label={`Move step ${i + 1} down`}>
                                ↓
                              </button>
                              <Menu label={<span aria-label={`Actions for step ${i + 1}`}>⋯</span>} className="btn sm ghost" floating>
                                {(c) => (
                                  <>
                                    <button onClick={() => (c(), duplicateStep(i))}>Duplicate</button>
                                    {STEP_KINDS.map((k) => (
                                      <button key={k} onClick={() => (c(), addStep(k, i + 1))}>
                                        Insert below: {STEP_KIND_LABEL[k]}
                                      </button>
                                    ))}
                                    <button onClick={() => (c(), removeStep(i))}>Delete step</button>
                                  </>
                                )}
                              </Menu>
                            </div>
                          </div>
                          {open && <StepForm step={s} index={i} steps={draft.steps} actors={draft.actors} actorKeys={actorKeys} issues={issues} ctx={ctx} onChange={(n) => setStep(i, n)} />}
                        </li>
                      );
                    })}
                  </ol>
                  {draft.steps.length > 0 && (
                    <div className="card-pad sb-steps-foot">
                      <AddStepMenu onAdd={(k) => addStep(k)} />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <aside className="sb-editor-side">
            <div className="card">
              <div className="card-head">
                <h3>Validation</h3>
                {validation && (
                  <span className="faint small">
                    {validation.refs.dataSets.length} data set{validation.refs.dataSets.length === 1 ? '' : 's'} · {validation.refs.roles.length} role{validation.refs.roles.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="card-pad">
                <IssueList issues={issues} onPick={pick} okText="No problems: ready to save." />
              </div>
            </div>
          </aside>
        </div>
      </div>
    </TplProvider>
  );
}

function AddStepMenu({ onAdd, primary }: { onAdd: (k: StepKind) => void; primary?: boolean }) {
  return (
    <Menu label={<><Icon name="plus" size={13} /> Add step</>} className={`btn sm ${primary ? 'primary' : ''}`} floating menuClassName="sb-kind-menu">
      {(close) => (
        <>
          {STEP_KINDS.map((k) => (
            <button key={k} onClick={() => (close(), onAdd(k))}>
              <strong>{STEP_KIND_LABEL[k]}</strong>
              <span className="faint small">{STEP_KIND_HELP[k]}</span>
            </button>
          ))}
        </>
      )}
    </Menu>
  );
}

function HeaderCard({ draft, set, isNew, issues }: { draft: Storyboard; set: (p: Partial<Storyboard>) => void; isNew: boolean; issues: Issues | null }) {
  const [tags, setTags] = useState((draft.tags ?? []).join(', '));
  const parseTags = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
  // Follow outside changes (JSON mode, save) without rewriting what is being typed ("a, " stays "a, ").
  useEffect(() => {
    setTags((cur) => (JSON.stringify(parseTags(cur)) === JSON.stringify(draft.tags ?? []) ? cur : (draft.tags ?? []).join(', ')));
  }, [draft.tags]);
  return (
    <div className="card card-pad stack">
      <div className="sb-grid">
        <Field label="Name" path="name" issues={issues}>
          <input value={draft.name} data-path="name" onChange={(e) => set({ name: e.target.value })} placeholder="Register for an event" />
        </Field>
        <Field label="Slug" hint={isNew ? 'lowercase, digits, dashes' : 'cannot be changed'} path="slug" issues={issues}>
          <input className="mono" value={draft.slug} data-path="slug" disabled={!isNew} onChange={(e) => set({ slug: e.target.value.toLowerCase() })} placeholder="register-event" />
        </Field>
        <Field label="Tags" hint="comma-separated" path="tags" issues={issues}>
          <input
            value={tags}
            data-path="tags"
            onChange={(e) => {
              setTags(e.target.value);
              set({ tags: parseTags(e.target.value) });
            }}
            placeholder="smoke, registration"
          />
        </Field>
        <Field label="Preferred run mode" hint="the start button the extension shows first" path="preferredMode" issues={issues}>
          <select value={draft.preferredMode ?? 'tracked'} data-path="preferredMode" onChange={(e) => set({ preferredMode: e.target.value as RunMode })}>
            <option value="tracked">Tracked walkthrough</option>
            <option value="quick">Quick test</option>
          </select>
        </Field>
        <Field label="Record" hint="the extension records the app pages of tracked runs (rrweb DOM recording)" path="record" issues={issues}>
          <select value={draft.record ?? 'off'} data-path="record" onChange={(e) => set({ record: e.target.value as RecordMode })}>
            <option value="off">Off</option>
            <option value="dom">Page recording (DOM)</option>
            <option value="video">Video (later release: records the DOM for now)</option>
          </select>
        </Field>
        {(draft.record ?? 'off') !== 'off' && (
          <Field label="Masking" hint="passwords and one-time codes are always masked" path="recordMaskAllInputs" issues={issues}>
            <label className="sb-check">
              <input type="checkbox" checked={draft.recordMaskAllInputs ?? false} data-path="recordMaskAllInputs" onChange={(e) => set({ recordMaskAllInputs: e.target.checked })} /> Mask every input value
            </label>
          </Field>
        )}
      </div>
      <Field label="Intent" hint="one sentence: what this walkthrough proves" path="intent" issues={issues}>
        <input value={draft.intent ?? ''} data-path="intent" onChange={(e) => set({ intent: e.target.value })} placeholder="A participant can register and gets approved by an admin" />
      </Field>
      <Field label="Description" path="description" issues={issues}>
        <textarea rows={2} value={draft.description ?? ''} data-path="description" onChange={(e) => set({ description: e.target.value })} />
      </Field>
    </div>
  );
}

function ActorsCard({ draft, set, issues, ctx }: { draft: Storyboard; set: (p: Partial<Storyboard>) => void; issues: Issues | null; ctx: EditorContext }) {
  const setActor = (i: number, patch: Partial<Actor>) =>
    set({
      actors: draft.actors.map((a, j) => {
        if (j !== i) return a;
        const n = { ...a, ...patch } as Record<string, unknown>;
        for (const k of ['label', 'user', 'name']) if (n[k] === '') delete n[k];
        return n as unknown as Actor;
      }),
    });
  return (
    <div className="card">
      <div className="card-head">
        <h3>
          Actors <span className="faint small">({draft.actors.length})</span>
        </h3>
        <button className="btn sm" onClick={() => set({ actors: [...draft.actors, { key: draft.actors.length ? `actor${draft.actors.length + 1}` : 'user', role: ctx.roles[0] ?? 'customer' }] })}>
          <Icon name="plus" size={13} /> Add actor
        </button>
      </div>
      <IssueNotes issues={issues} path="actors" />
      <datalist id="sb-roles">
        {ctx.roles.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <datalist id="sb-users">
        {ctx.users.map((u) => (
          <option key={u.id} value={u.email ?? u.name}>
            {u.name} ({u.role})
          </option>
        ))}
      </datalist>
      {!draft.actors.length && <p className="muted small card-pad" style={{ margin: 0 }}>Add at least one actor: the person (test user) who does the steps.</p>}
      <div className="sb-rows">
        {draft.actors.map((a, i) => (
          <div key={i} className="sb-row">
            <div className="sb-grid">
              <Field label="Key" hint="used in steps" path={`actors[${i}].key`} issues={issues}>
                <input className="mono" value={a.key} data-path={`actors[${i}].key`} onChange={(e) => setActor(i, { key: e.target.value })} placeholder="participant" />
              </Field>
              <Field label="Label" path={`actors[${i}].label`} issues={issues}>
                <input value={a.label ?? ''} data-path={`actors[${i}].label`} onChange={(e) => setActor(i, { label: e.target.value })} placeholder="The participant" />
              </Field>
              <Field label="Role" hint="picks the login recipe" path={`actors[${i}].role`} issues={issues}>
                <input value={a.role} list="sb-roles" data-path={`actors[${i}].role`} onChange={(e) => setActor(i, { role: e.target.value.toLowerCase() })} />
              </Field>
              {a.fresh ? (
                <Field label="Name template" hint="fresh user" path={`actors[${i}].name`} issues={issues}>
                  <Tpl value={a.name} path={`actors[${i}].name`} onChange={(v) => setActor(i, { name: v })} placeholder="{{fake.firstName}} {{fake.lastName}}" />
                </Field>
              ) : (
                <Field label="Test user" hint="empty: first user with the role" path={`actors[${i}].user`} issues={issues}>
                  <input value={a.user ?? ''} list="sb-users" data-path={`actors[${i}].user`} onChange={(e) => setActor(i, { user: e.target.value })} placeholder="email, name or id" />
                </Field>
              )}
            </div>
            <div className="sb-row-side">
              <label className="sb-check" title="Create a new test user for every walkthrough">
                <input type="checkbox" checked={!!a.fresh} onChange={(e) => setActor(i, e.target.checked ? { fresh: true, user: undefined } : { fresh: false, name: undefined })} /> Fresh user
              </label>
              <button className="btn sm ghost" onClick={() => set({ actors: draft.actors.filter((_, j) => j !== i) })} aria-label={`Remove actor ${a.key}`}>
                ✕
              </button>
            </div>
            <IssueNotes issues={issues} path={`actors[${i}]`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function InputsCard({ draft, set, issues }: { draft: Storyboard; set: (p: Partial<Storyboard>) => void; issues: Issues | null }) {
  const inputs = draft.inputs ?? [];
  const setInput = (i: number, patch: Partial<Input>) =>
    set({
      inputs: inputs.map((x, j) => {
        if (j !== i) return x;
        const n = { ...x, ...patch } as Record<string, unknown>;
        for (const k of ['default', 'help']) if (n[k] === '') delete n[k];
        return n as unknown as Input;
      }),
    });
  return (
    <div className="card">
      <div className="card-head">
        <h3>
          Inputs <span className="faint small">({inputs.length}) · asked when a walkthrough starts, used as {'{{vars.<name>}}'}</span>
        </h3>
        <button className="btn sm" onClick={() => set({ inputs: [...inputs, { name: '', label: '' }] })}>
          <Icon name="plus" size={13} /> Add input
        </button>
      </div>
      {inputs.length > 0 && (
        <div className="sb-rows">
          {inputs.map((x, i) => (
            <div key={i} className="sb-row">
              <div className="sb-grid">
                <Field label="Name" path={`inputs[${i}].name`} issues={issues}>
                  <input className="mono" value={x.name} data-path={`inputs[${i}].name`} onChange={(e) => setInput(i, { name: e.target.value })} placeholder="eventCode" />
                </Field>
                <Field label="Label" path={`inputs[${i}].label`} issues={issues}>
                  <input value={x.label} data-path={`inputs[${i}].label`} onChange={(e) => setInput(i, { label: e.target.value })} placeholder="Event code" />
                </Field>
                <Field label="Default" path={`inputs[${i}].default`} issues={issues}>
                  <input value={x.default ?? ''} data-path={`inputs[${i}].default`} onChange={(e) => setInput(i, { default: e.target.value })} />
                </Field>
                <Field label="Help" path={`inputs[${i}].help`} issues={issues}>
                  <input value={x.help ?? ''} data-path={`inputs[${i}].help`} onChange={(e) => setInput(i, { help: e.target.value })} />
                </Field>
              </div>
              <div className="sb-row-side">
                <label className="sb-check">
                  <input type="checkbox" checked={!!x.required} onChange={(e) => setInput(i, { required: e.target.checked })} /> Required
                </label>
                <button className="btn sm ghost" onClick={() => set({ inputs: inputs.filter((_, j) => j !== i) })} aria-label={`Remove input ${x.name}`}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StepForm({
  step: s,
  index: i,
  steps,
  actors,
  actorKeys,
  issues,
  ctx,
  onChange,
}: {
  step: Step;
  index: number;
  steps: Step[];
  actors: Actor[];
  actorKeys: string[];
  issues: Issues | null;
  ctx: EditorContext;
  onChange: (s: Step) => void;
}) {
  const p = (f: string) => `steps[${i}].${f}`;
  const up = (patch: Partial<Record<keyof Step, unknown>>) => onChange(patchStep(s, patch));
  const nested = (key: 'match' | 'link' | 'assert' | 'target', field: string, v: unknown) => onChange(patchNested(s, key, field, v));
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const actorRequired = s.kind === 'login' || s.kind === 'email';
  const shownKeys = useMemo(() => new Set(['title', 'intent', 'actor', 'notes', 'optional', 'screenshot', 'kind', 'id', 'target.selector', 'target.text', ...stepFieldPaths(s.kind)]), [s.kind]);
  const others = issues
    ? {
        errors: issues.errors.filter((x) => x.path.startsWith(`steps[${i}]`) && !shownKeys.has(x.path.slice(`steps[${i}].`.length))),
        warnings: issues.warnings.filter((x) => x.path.startsWith(`steps[${i}]`) && !shownKeys.has(x.path.slice(`steps[${i}].`.length))),
      }
    : null;

  return (
    <div className="sb-step-body stack">
      {others && (others.errors.length > 0 || others.warnings.length > 0) && <IssueList issues={others} />}
      <div className="sb-grid">
        <Field label="Kind" path={p('kind')} issues={issues}>
          <select value={s.kind} data-path={p('kind')} onChange={(e) => onChange(changeKind(s, e.target.value as StepKind, steps, actors))}>
            {STEP_KINDS.map((k) => (
              <option key={k} value={k}>
                {STEP_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" path={p('title')} issues={issues}>
          <input value={s.title} data-path={p('title')} onChange={(e) => up({ title: e.target.value })} placeholder="Open the registration page" />
        </Field>
        <Field label="Actor" hint={actorRequired ? 'required' : 'empty: previous step'} path={p('actor')} issues={issues}>
          <select value={s.actor ?? ''} data-path={p('actor')} onChange={(e) => up({ actor: e.target.value })}>
            <option value="">{actorRequired ? '— choose —' : '(same as previous step)'}</option>
            {actorKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
            {s.actor && !actorKeys.includes(s.actor) && <option value={s.actor}>{s.actor} (unknown)</option>}
          </select>
        </Field>
      </div>
      <Field label="Intent" hint="required: what the user does and why, in one plain sentence" path={p('intent')} issues={issues}>
        <input value={s.intent} data-path={p('intent')} onChange={(e) => up({ intent: e.target.value })} placeholder="The participant opens the public registration form for the event" />
      </Field>

      <KindFields s={s} p={p} up={up} nested={nested} num={num} issues={issues} ctx={ctx} />

      <details className="sb-more">
        <summary>Notes, screenshot and highlight</summary>
        <div className="stack" style={{ marginTop: 10 }}>
          <Field label="Notes for the human" path={p('notes')} issues={issues}>
            <Tpl multiline mono={false} value={s.notes} path={p('notes')} onChange={(v) => onChange({ ...s, notes: v })} />
          </Field>
          <div className="sb-grid">
            <Field label="Screenshot" path={p('screenshot')} issues={issues}>
              <select value={s.screenshot ?? 'offer'} data-path={p('screenshot')} onChange={(e) => up({ screenshot: e.target.value })}>
                <option value="off">Off</option>
                <option value="offer">Offer</option>
                <option value="required">Required</option>
              </select>
            </Field>
            <Field label="Highlight selector" path={p('target.selector')} issues={issues}>
              <input className="mono" value={s.target?.selector ?? ''} data-path={p('target.selector')} onChange={(e) => nested('target', 'selector', e.target.value)} placeholder="#submit" />
            </Field>
            <Field label="Highlight text" path={p('target.text')} issues={issues}>
              <input value={s.target?.text ?? ''} data-path={p('target.text')} onChange={(e) => nested('target', 'text', e.target.value)} placeholder="Register" />
            </Field>
          </div>
          <label className="sb-check">
            <input type="checkbox" checked={!!s.optional} onChange={(e) => up({ optional: e.target.checked })} /> Optional step (can be skipped at sign-off)
          </label>
        </div>
      </details>
    </div>
  );
}

function stepFieldPaths(kind: StepKind): string[] {
  switch (kind) {
    case 'open':
    case 'logout':
      return ['url'];
    case 'login':
      return ['recipe', 'url'];
    case 'fill':
      return ['dataSet', 'url', 'formId'];
    case 'email':
      return ['channel', 'match.subject', 'match.text', 'link.pattern', 'link.index', 'timeoutSec', 'open'];
    case 'capture':
      return ['var', 'selector', 'attribute', 'textPattern', 'required'];
    case 'check':
      return ['expect', 'assert.textPresent', 'assert.selector', 'assert.urlMatches'];
    default:
      return [];
  }
}

function KindFields({
  s,
  p,
  up,
  nested,
  num,
  issues,
  ctx,
}: {
  s: Step;
  p: (f: string) => string;
  up: (patch: Partial<Record<keyof Step, unknown>>) => void;
  nested: (key: 'match' | 'link' | 'assert' | 'target', field: string, v: unknown) => void;
  num: (v: string) => number | undefined;
  issues: Issues | null;
  ctx: EditorContext;
}) {
  const url = (label: string, hint: string, placeholder = '/path or https://…') => (
    <Field label={label} hint={hint} path={p('url')} issues={issues}>
      <Tpl value={s.url} path={p('url')} onChange={(v) => up({ url: v })} placeholder={placeholder} />
    </Field>
  );
  switch (s.kind) {
    case 'open':
      return url('URL', 'relative URLs use the app origin', '/register/{{vars.eventCode}}');
    case 'login':
      return (
        <div className="sb-grid">
          <Field label="Login recipe" hint="empty: the actor's role" path={p('recipe')} issues={issues}>
            <select value={s.recipe ?? ''} data-path={p('recipe')} onChange={(e) => up({ recipe: e.target.value })}>
              <option value="">(actor role)</option>
              {ctx.recipes.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              {s.recipe && !ctx.recipes.includes(s.recipe) && <option value={s.recipe}>{s.recipe} (missing)</option>}
            </select>
          </Field>
          {url('Login URL', "empty: the recipe's URL")}
        </div>
      );
    case 'logout':
      return url('Logout URL', "empty: the recipe's logout URL");
    case 'fill':
      return (
        <div className="sb-grid">
          <Field label="Data set" path={p('dataSet')} issues={issues}>
            <select value={s.dataSet ?? ''} data-path={p('dataSet')} onChange={(e) => up({ dataSet: e.target.value })}>
              <option value="">— choose —</option>
              {ctx.dataSets.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              {s.dataSet && !ctx.dataSets.includes(s.dataSet) && <option value={s.dataSet}>{s.dataSet} (missing)</option>}
            </select>
          </Field>
          {url('Page URL', 'optional: opened before filling')}
          <Field label="Form id" hint="optional" path={p('formId')} issues={issues}>
            <input className="mono" value={s.formId ?? ''} data-path={p('formId')} onChange={(e) => up({ formId: e.target.value })} />
          </Field>
        </div>
      );
    case 'email':
      return (
        <>
          <div className="sb-grid">
            <Field label="Channel" path={p('channel')} issues={issues}>
              <select value={s.channel ?? 'email'} data-path={p('channel')} onChange={(e) => up({ channel: e.target.value })}>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
            </Field>
            <Field label="Subject" hint="substring or /regex/" path={p('match.subject')} issues={issues}>
              <input className="mono" value={s.match?.subject ?? ''} data-path={p('match.subject')} onChange={(e) => nested('match', 'subject', e.target.value)} placeholder="/registration (approved|received)/i" />
            </Field>
            <Field label="Text" hint="must be in subject or body" path={p('match.text')} issues={issues}>
              <Tpl value={s.match?.text} path={p('match.text')} onChange={(v) => nested('match', 'text', v)} />
            </Field>
          </div>
          <div className="sb-grid">
            <Field label="Link pattern" hint="substring or /regex/" path={p('link.pattern')} issues={issues}>
              <input className="mono" value={s.link?.pattern ?? ''} data-path={p('link.pattern')} onChange={(e) => nested('link', 'pattern', e.target.value)} placeholder="/verify" />
            </Field>
            <Field label="Link index" hint="empty: the human picks" path={p('link.index')} issues={issues}>
              <input type="number" min={0} max={50} value={s.link?.index ?? ''} data-path={p('link.index')} onChange={(e) => nested('link', 'index', num(e.target.value))} />
            </Field>
            <Field label="Timeout (s)" path={p('timeoutSec')} issues={issues}>
              <input type="number" min={5} max={600} value={s.timeoutSec ?? ''} data-path={p('timeoutSec')} onChange={(e) => up({ timeoutSec: num(e.target.value) })} placeholder="120" />
            </Field>
            <Field label="Open link" path={p('open')} issues={issues}>
              <select value={s.open ?? 'same-tab'} data-path={p('open')} onChange={(e) => up({ open: e.target.value })}>
                <option value="same-tab">Same tab</option>
                <option value="new-tab">New tab</option>
                <option value="none">Don't open</option>
              </select>
            </Field>
          </div>
        </>
      );
    case 'capture':
      return (
        <>
          <div className="sb-grid">
            <Field label="Variable" hint="read later as {{vars.<name>}}" path={p('var')} issues={issues}>
              <input className="mono" value={s.var ?? ''} data-path={p('var')} onChange={(e) => up({ var: e.target.value })} placeholder="regNo" />
            </Field>
            <Field label="Selector" hint="selector or text pattern" path={p('selector')} issues={issues}>
              <input className="mono" value={s.selector ?? ''} data-path={p('selector')} onChange={(e) => up({ selector: e.target.value })} placeholder="#reg-number" />
            </Field>
            <Field label="Attribute" hint="empty: text / value" path={p('attribute')} issues={issues}>
              <input className="mono" value={s.attribute ?? ''} data-path={p('attribute')} onChange={(e) => up({ attribute: e.target.value })} placeholder="data-id" />
            </Field>
            <Field label="Text pattern" hint="regex; group 1 is the value" path={p('textPattern')} issues={issues}>
              <input className="mono" value={s.textPattern ?? ''} data-path={p('textPattern')} onChange={(e) => up({ textPattern: e.target.value })} placeholder={'Registration no\\.?\\s*(\\w+)'} />
            </Field>
          </div>
          <label className="sb-check">
            <input type="checkbox" checked={s.required !== false} onChange={(e) => up({ required: e.target.checked })} /> Required (the step fails without a value)
          </label>
        </>
      );
    case 'check':
      return (
        <>
          <Field label="Expect" hint="what the human should see" path={p('expect')} issues={issues}>
            <input value={s.expect ?? ''} data-path={p('expect')} onChange={(e) => up({ expect: e.target.value })} placeholder="The confirmation page shows the registration number" />
          </Field>
          <div className="sb-grid">
            <Field label="Assert text present" path={p('assert.textPresent')} issues={issues}>
              <Tpl value={s.assert?.textPresent} path={p('assert.textPresent')} onChange={(v) => nested('assert', 'textPresent', v)} placeholder="{{vars.regNo}}" />
            </Field>
            <Field label="Assert selector" path={p('assert.selector')} issues={issues}>
              <input className="mono" value={s.assert?.selector ?? ''} data-path={p('assert.selector')} onChange={(e) => nested('assert', 'selector', e.target.value)} />
            </Field>
            <Field label="Assert URL matches" path={p('assert.urlMatches')} issues={issues}>
              <input className="mono" value={s.assert?.urlMatches ?? ''} data-path={p('assert.urlMatches')} onChange={(e) => nested('assert', 'urlMatches', e.target.value)} placeholder="/thanks" />
            </Field>
          </div>
        </>
      );
    default:
      return <p className="muted small" style={{ margin: 0 }}>The human follows the intent and notes, then marks the step done.</p>;
  }
}
