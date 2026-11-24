import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, StatusBadge, Tabs, type Status } from '../components/layout';
import { Icon } from '../components/people';
import { Markdown } from '../components/Markdown';
import { Badge, Drawer, ErrorBox, fmtBytes, timeAgo, useCopy, useToast } from '../components/ui';
import { useProject } from '../context';
import {
  MAX_IMAGES,
  PRIORITIES,
  PRIORITY_LABEL,
  STATUSES,
  STATUS_KIND,
  STATUS_LABEL,
  featuresApi,
  featuresBase,
  imageProblem,
  type Feature,
  type FeatureBrief,
  type FeatureImage,
  type FeatureList,
  type FeaturePriority,
  type FeatureStatus,
  type FeatureTask,
} from '../featuresApi';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { projectPath } from '../nav';
import { Page } from './ProjectPage';
import { needRole, useAuth, useCan } from '../auth';
import { membersApi, type ProjectMember } from '../teamApi';
import '../styles/features.css';

/**
 * What the signed-in role may change (Teams mode; always everything otherwise): `edit` = features, status, order and
 * tasks (features.edit), `details` = markdown details and images (features.details, the Designer role).
 */
const FeatAccess = createContext({ edit: true, details: true });
const useFeatAccess = () => useContext(FeatAccess);
/** The datalist of project members offered for a task's assignee (free text stays allowed). */
const ASSIGNEE_LIST = 'feat-assignees';

/**
 * /p/:slug/features — the project's features board: features (status, priority, markdown details, images, an
 * optional storyboard link) with tasks and subtasks. List (grouped by status) or board view; the detail opens in a
 * drawer (?f=F-3). An AI agent edits the same board through MCP (list_features, add_task, …).
 */

type Filter = FeatureStatus | 'all';
type View = 'list' | 'board';

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
/** After an up/down move keep focus on the moved item's button (the other one when it reached the end). */
const focusMove = (attr: string, id: string, dir: number) => {
  const btn = (d: number) => document.querySelector<HTMLButtonElement>('[' + attr + '="' + id + ':' + d + '"]');
  const b = btn(dir);
  (b && !b.disabled ? b : btn(-dir))?.focus();
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function FeaturesPage() {
  const { slug } = useProject();
  const toast = useToast();
  const can = useCan();
  const access = useMemo(() => ({ edit: can('features.edit', slug), details: can('features.details', slug) }), [can, slug]);
  const teams = useAuth().mode === 'teams';
  const [members, setMembers] = useState<ProjectMember[]>([]);
  useEffect(() => {
    if (!teams) return;
    let live = true;
    membersApi
      .list(slug)
      .then((r) => live && setMembers(r.members.filter((m) => !m.disabled)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [slug, teams]);
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const filter: Filter = rawStatus && (STATUSES as string[]).includes(rawStatus) ? (rawStatus as FeatureStatus) : 'all';
  const view: View = params.get('view') === 'board' ? 'board' : 'list';
  const openRef = params.get('f');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [dq, setDq] = useState(q.trim());
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const setParam = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') n.delete(k);
            else n.set(k, v);
          }
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );
  useEffect(() => setParam({ q: dq || null }), [dq, setParam]);

  const list = useFetch<FeatureList>(featuresBase(slug) + (dq ? '?q=' + encodeURIComponent(dq) : ''), [slug, dq]);
  const reload = useDebounced(() => void list.reload(), 150);
  useHubEvents(slug, (e) => {
    if (e.type === 'features.changed' || e.type === 'project.reset' || e.type === 'storyboards.changed') reload();
  });

  const all = useMemo(() => list.data?.features ?? [], [list.data]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: all.length, idea: 0, planned: 0, in_progress: 0, done: 0 };
    for (const f of all) c[f.status]++;
    return c;
  }, [all]);
  const shown = filter === 'all' ? all : all.filter((f) => f.status === filter);

  // Quick add: title only, Enter. New features get the filtered status (Idea when showing all).
  const quickRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || adding) return;
    setAdding(true);
    try {
      const f = await featuresApi.create(slug, { title: t, status: filter === 'all' ? 'idea' : filter });
      setTitle('');
      toast('Added ' + f.key);
      void list.reload();
    } catch (err) {
      toast(errMsg(err));
    } finally {
      setAdding(false);
      quickRef.current?.focus();
    }
  };
  // "n" focuses quick add.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || openRef) return;
      if (document.querySelector('.overlay')) return;
      e.preventDefault();
      quickRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openRef]);

  const open = (f: FeatureBrief) => setParam({ f: f.key });
  const move = async (f: FeatureBrief, dir: -1 | 1, group: FeatureBrief[]) => {
    const i = group.findIndex((x) => x.id === f.id);
    const other = group[i + dir];
    if (!other) return;
    try {
      // Reorder fills the slots the two hold now, in the given order: the first gets the earlier slot.
      const r = await featuresApi.reorder(slug, dir < 0 ? [f.id, other.id] : [other.id, f.id]);
      // During a search the response (the whole board) would replace the results: fetch the filtered list again.
      if (dq) await list.reload();
      else list.setData((d) => (d ? { ...d, features: r.features } : d));
      requestAnimationFrame(() => focusMove('data-move', f.key, dir));
    } catch (err) {
      toast(errMsg(err));
    }
  };
  const setStatus = async (f: FeatureBrief, status: FeatureStatus) => {
    try {
      await featuresApi.update(slug, f.id, { status });
      toast(f.key + ' → ' + STATUS_LABEL[status]);
      void list.reload();
    } catch (err) {
      toast(errMsg(err));
    }
  };

  const tabs = [{ id: 'all' as Filter, label: 'All', count: counts.all, zero: true }, ...STATUSES.map((s) => ({ id: s as Filter, label: STATUS_LABEL[s], count: counts[s], zero: true }))];
  const lower = (s: FeatureStatus) => STATUS_LABEL[s].toLowerCase();

  return (
    <FeatAccess.Provider value={access}>
    {members.length > 0 && (
      <datalist id={ASSIGNEE_LIST}>
        {members.map((m) => (
          <option key={m.userId} value={m.name || m.email}>
            {m.name ? m.email : undefined}
          </option>
        ))}
      </datalist>
    )}
    <Page
      title="Features"
      description="A light plan for this project: features with markdown details and images, their tasks and subtasks. AI agents read and update it through MCP (list_features, get_feature, add_task, update_task)."
      meta={list.data ? <Badge>{counts.all}</Badge> : undefined}
      toolbar={
        <div className="feat-toolbar">
          <Tabs variant="filter" label="Status" items={tabs} value={filter} onChange={(id) => setParam({ status: id === 'all' ? null : id })} />
          <div className="feat-toolbar-end">
            <input type="search" className="feat-search" placeholder="Search features and tasks" aria-label="Search features and tasks" value={q} onChange={(e) => setQ(e.target.value)} />
            <Tabs
              variant="segmented"
              label="View"
              items={[
                { id: 'list' as View, label: 'List' },
                { id: 'board' as View, label: 'Board' },
              ]}
              value={view}
              onChange={(v) => setParam({ view: v === 'list' ? null : v })}
            />
          </div>
        </div>
      }
    >
      {access.edit && (
      <form className="feat-quick card" onSubmit={add}>
        <Icon name="plus" size={16} />
        <input
          ref={quickRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={'Add a feature' + (filter === 'all' ? '' : ' (' + STATUS_LABEL[filter] + ')') + ': type a title, press Enter'}
          aria-label="New feature title"
          maxLength={200}
          data-testid="feature-quick-add"
        />
        <button className="btn sm primary" disabled={!title.trim() || adding}>
          Add
        </button>
      </form>
      )}
      <ErrorBox error={list.error} />
      {!list.data ? (
        list.error ? null : <p className="muted">Loading…</p>
      ) : all.length === 0 && !dq ? (
        <div className="card">
          <EmptyState icon="flag" title="No features yet">
            Write down what this project should do: one feature per idea, with tasks and subtasks, details and screenshots. Type a title above and press Enter.
          </EmptyState>
        </div>
      ) : shown.length === 0 ? (
        <div className="card">
          <EmptyState icon="search" title="Nothing matches">
            {dq ? 'No ' + (filter === 'all' ? '' : lower(filter) + ' ') + 'features or tasks match “' + dq + '”.' : 'No ' + lower(filter as FeatureStatus) + ' features.'}
          </EmptyState>
        </div>
      ) : view === 'board' ? (
        <BoardView features={shown} statuses={filter === 'all' ? STATUSES : [filter]} onOpen={open} onStatus={setStatus} />
      ) : filter === 'all' ? (
        STATUSES.filter((s) => counts[s] > 0 || !dq).map((s) => {
          const group = shown.filter((f) => f.status === s);
          return (
            <section key={s} className="card feat-group" aria-labelledby={'feat-g-' + s}>
              <div className="feat-group-head">
                <h2 id={'feat-g-' + s}>{STATUS_LABEL[s]}</h2>
                <span className="feat-count">{group.length}</span>
              </div>
              {group.length ? <FeatureRows rows={group} onOpen={open} onMove={move} /> : <p className="feat-none">No {lower(s)} features.</p>}
            </section>
          );
        })
      ) : (
        <section className="card feat-group" aria-label={STATUS_LABEL[filter] + ' features'}>
          <FeatureRows rows={shown} onOpen={open} onMove={move} />
        </section>
      )}
      {openRef && <FeatureDrawer slug={slug} featureRef={openRef} onClose={() => setParam({ f: null })} onChanged={() => void list.reload()} />}
    </Page>
    </FeatAccess.Provider>
  );
}

// ------------------------------------------------------------------------------------------------ list + board

export function Progress({ done, total, compact }: { done: number; total: number; compact?: boolean }) {
  if (!total) return compact ? null : <span className="feat-progress muted">No tasks yet</span>;
  const pct = Math.round((done / total) * 100);
  return (
    <span className="feat-progress" title={done + ' of ' + total + ' tasks and subtasks done'}>
      <span className="feat-bar" aria-hidden>
        <span style={{ width: pct + '%' }} />
      </span>
      <span className="sr-only">Tasks done:</span>
      <span>
        {done}/{total}
      </span>
    </span>
  );
}

const PRIORITY_KIND: Record<FeaturePriority, string> = { none: '', low: '', medium: 'info', high: 'bad' };
export function PriorityBadge({ p }: { p: FeaturePriority }) {
  if (p === 'none') return null;
  return (
    <Badge kind={'feat-prio ' + PRIORITY_KIND[p]} title={'Priority: ' + PRIORITY_LABEL[p]}>
      {PRIORITY_LABEL[p]}
    </Badge>
  );
}

function FeatureMeta({ f }: { f: FeatureBrief }) {
  return (
    <>
      <PriorityBadge p={f.priority} />
      <Progress done={f.progress.done} total={f.progress.total} compact />
      {f.imageCount > 0 && (
        <span className="feat-imgs" title={plural(f.imageCount, 'image')}>
          <Icon name="image" size={14} />
          <span className="sr-only">Images:</span> {f.imageCount}
        </span>
      )}
    </>
  );
}

function FeatureRows({ rows, onOpen, onMove }: { rows: FeatureBrief[]; onOpen: (f: FeatureBrief) => void; onMove: (f: FeatureBrief, dir: -1 | 1, group: FeatureBrief[]) => void }) {
  const { edit } = useFeatAccess();
  return (
    <ul className="feat-rows">
      {rows.map((f, i) => (
        <li key={f.id} className="feat-row" data-testid="feature-row">
          <button type="button" className="feat-open" onClick={() => onOpen(f)}>
            <span className="feat-key">{f.key}</span>
            <span className="feat-title">{f.title}</span>
          </button>
          <div className="feat-meta">
            <StatusBadge status={(STATUS_KIND[f.status] || 'neutral') as Status}>{STATUS_LABEL[f.status]}</StatusBadge>
            <FeatureMeta f={f} />
          </div>
          {edit && (
          <div className="feat-move">
            <button type="button" className="btn xs ghost" disabled={i === 0} onClick={() => onMove(f, -1, rows)} aria-label={'Move ' + f.key + ' up'} title="Move up" data-move={f.key + ':-1'}>
              ↑
            </button>
            <button type="button" className="btn xs ghost" disabled={i === rows.length - 1} onClick={() => onMove(f, 1, rows)} aria-label={'Move ' + f.key + ' down'} title="Move down" data-move={f.key + ':1'}>
              ↓
            </button>
          </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function BoardView({ features, statuses, onOpen, onStatus }: { features: FeatureBrief[]; statuses: FeatureStatus[]; onOpen: (f: FeatureBrief) => void; onStatus: (f: FeatureBrief, s: FeatureStatus) => void }) {
  const { edit } = useFeatAccess();
  return (
    <div className={'feat-board cols-' + statuses.length}>
      {statuses.map((s) => {
        const col = features.filter((f) => f.status === s);
        return (
          <section key={s} className="feat-col" aria-labelledby={'feat-col-' + s}>
            <div className="feat-col-head">
              <h2 id={'feat-col-' + s}>{STATUS_LABEL[s]}</h2>
              <span className="feat-count">{col.length}</span>
            </div>
            {col.length === 0 && <p className="feat-none">Nothing here.</p>}
            {col.map((f) => {
              const at = STATUSES.indexOf(f.status);
              const prev = STATUSES[at - 1];
              const next = STATUSES[at + 1];
              return (
                <article key={f.id} className="feat-card" data-testid="feature-card">
                  <button type="button" className="feat-open" onClick={() => onOpen(f)}>
                    <span className="feat-key">{f.key}</span>
                    <span className="feat-title">{f.title}</span>
                  </button>
                  <div className="feat-meta">
                    <FeatureMeta f={f} />
                  </div>
                  {edit && (
                  <div className="feat-card-move">
                    {prev && (
                      <button type="button" className="btn xs ghost" onClick={() => onStatus(f, prev)} aria-label={'Move ' + f.key + ' to ' + STATUS_LABEL[prev]}>
                        ← {STATUS_LABEL[prev]}
                      </button>
                    )}
                    {next && (
                      <button type="button" className="btn xs ghost" onClick={() => onStatus(f, next)} aria-label={'Move ' + f.key + ' to ' + STATUS_LABEL[next]}>
                        {STATUS_LABEL[next]} →
                      </button>
                    )}
                  </div>
                  )}
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ detail drawer

/** Two-step delete: the button turns into "question  Delete  Cancel" (no native dialog, keyboard friendly). */
function ConfirmButton({ label, question, onConfirm, className = 'btn xs ghost danger', ariaLabel }: { label: ReactNode; question: string; onConfirm: () => void; className?: string; ariaLabel?: string }) {
  const [asking, setAsking] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) yes.current?.focus();
  }, [asking]);
  if (!asking)
    return (
      <button type="button" className={className} onClick={() => setAsking(true)} aria-label={ariaLabel}>
        {label}
      </button>
    );
  return (
    <span
      className="feat-confirm"
      role="group"
      aria-label={question}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setAsking(false);
        }
      }}
    >
      <span>{question}</span>
      <button
        ref={yes}
        type="button"
        className="btn xs danger"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Delete
      </button>
      <button type="button" className="btn xs ghost" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

/** Click to edit; Enter saves, Esc cancels (and does not close the drawer). */
function InlineText({ value, onSave, label, className = '', maxLength = 200 }: { value: string; onSave: (v: string) => Promise<boolean | void> | boolean | void; label: string; className?: string; maxLength?: number }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const saving = useRef(false);
  const { edit } = useFeatAccess();
  useEffect(() => setV(value), [value]);
  if (!edit) return <span className={'feat-inline readonly ' + className}>{value}</span>;
  if (!editing)
    return (
      <button type="button" className={'feat-inline ' + className} onClick={() => setEditing(true)} title={'Edit ' + label.toLowerCase()} aria-label={label + ': ' + value + '. Edit'}>
        {value}
      </button>
    );
  /** Leaves edit mode only once the save worked (onSave resolving false = failed): a failed save keeps the typed text. */
  const done = async (save: boolean) => {
    if (saving.current) return;
    const t = v.trim();
    if (!save || !t || t === value) {
      setV(value);
      setEditing(false);
      return;
    }
    saving.current = true;
    const ok = await onSave(t);
    saving.current = false;
    if (ok !== false) setEditing(false);
  };
  return (
    <input
      className={'feat-inline-input ' + className}
      autoFocus
      value={v}
      maxLength={maxLength}
      aria-label={label}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void done(true);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          void done(false);
        }
      }}
    />
  );
}

function FeatureDrawer({ slug, featureRef, onClose, onChanged }: { slug: string; featureRef: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const access = useFeatAccess();
  const feat = useFetch<Feature>(featuresBase(slug) + '/' + encodeURIComponent(featureRef), [slug, featureRef]);
  const storyboards = useFetch<{ id: string; slug: string; name: string }[]>('/api/projects/' + slug + '/storyboards', [slug]);
  const reload = useDebounced(() => void feat.reload(), 120);
  const f = feat.data;
  useHubEvents(slug, (e) => {
    const d = e.data as { id?: string } | null;
    if ((e.type === 'features.changed' && (!d?.id || d.id === f?.id)) || e.type === 'storyboards.changed') reload();
  });
  const [lightbox, setLightbox] = useState<number | null>(null);

  /** Resolves true when the call worked; on failure it shows the error and resolves false. */
  const run: Run = async (p, msg) => {
    let ok = true;
    try {
      await p;
      if (msg) toast(msg);
    } catch (err) {
      ok = false;
      toast(errMsg(err));
    }
    void feat.reload();
    onChanged();
    return ok;
  };
  const patch = (body: Parameters<typeof featuresApi.update>[2], msg?: string) => (f ? run(featuresApi.update(slug, f.id, body), msg) : Promise.resolve(false));

  const upload = async (files: File[]): Promise<FeatureImage[]> => {
    if (!f) return [];
    const out: FeatureImage[] = [];
    let room = MAX_IMAGES - f.images.length;
    for (const file of files) {
      const problem = imageProblem(file);
      if (problem) {
        toast(problem);
        continue;
      }
      if (room <= 0) {
        toast('At most ' + MAX_IMAGES + ' images per feature; delete some first');
        break;
      }
      try {
        const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
        const name = file.name && file.name !== 'image.png' ? file.name : 'pasted-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + ext;
        out.push(await featuresApi.uploadImage(slug, f.id, file, name));
        room--;
      } catch (err) {
        toast(errMsg(err));
      }
    }
    if (out.length) {
      toast('Added ' + plural(out.length, 'image'));
      void feat.reload();
      onChanged();
    }
    return out;
  };

  const images = f?.images ?? [];
  const imageFor = (src: string) => {
    if (!src.startsWith('image:')) return null;
    const idx = images.findIndex((i) => i.id === src.slice(6));
    if (idx < 0) return null;
    return { url: images[idx].url, title: 'Open ' + images[idx].name, onOpen: () => setLightbox(idx) };
  };
  const deleteQuestion = (x: Feature) => {
    const parts = [x.progress.total ? plural(x.progress.total, 'task') : '', x.images.length ? plural(x.images.length, 'image') : ''].filter(Boolean);
    return 'Delete ' + x.key + (parts.length ? ' with ' + parts.join(' and ') : '') + '?';
  };

  return (
    <Drawer
      title={
        <div className="feat-drawer-title">
          <span className="feat-key">{f?.key ?? featureRef}</span>
          <span className="feat-drawer-name">{f?.title ?? ''}</span>
        </div>
      }
      onClose={onClose}
      actions={
        f && access.edit && (
          <ConfirmButton
            label="Delete"
            className="btn sm ghost danger"
            ariaLabel={'Delete ' + f.key}
            question={deleteQuestion(f)}
            onConfirm={() =>
              void featuresApi
                .remove(slug, f.id)
                .then(() => {
                  toast('Deleted ' + f.key);
                  onChanged();
                  onClose();
                })
                .catch((e) => toast(errMsg(e)))
            }
          />
        )
      }
    >
      <ErrorBox error={feat.error} />
      {!f ? (
        !feat.error && <p className="muted">Loading…</p>
      ) : (
        <div
          className="feat-detail"
          onPaste={(e: ClipboardEvent) => {
            if (isTyping(e.target)) return; // the details editor handles its own paste
            const files = [...e.clipboardData.files].filter((x) => x.type.startsWith('image/'));
            if (files.length && access.details) {
              e.preventDefault();
              void upload(files);
            }
          }}
        >
          <InlineText value={f.title} label="Title" className="feat-detail-title" onSave={(title) => patch({ title })} />
          <div className="feat-fields">
            <label className="field">
              <span>Status</span>
              <select value={f.status} onChange={(e) => void patch({ status: e.target.value as FeatureStatus })} data-testid="feature-status" disabled={!access.edit} title={access.edit ? undefined : needRole('features.edit')}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Priority</span>
              <select value={f.priority} onChange={(e) => void patch({ priority: e.target.value as FeaturePriority })} disabled={!access.edit} title={access.edit ? undefined : needRole('features.edit')}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p === 'none' ? 'None' : PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field feat-field-wide">
              <span>Storyboard</span>
              <select disabled={!access.edit} title={access.edit ? undefined : needRole('features.edit')} value={f.storyboard?.slug ?? ''} onChange={(e) => void patch({ storyboard: e.target.value || null }, e.target.value ? 'Storyboard linked' : 'Storyboard unlinked')}>
                <option value="">None</option>
                {(storyboards.data ?? []).map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {f.storyboard && (
              <Link className="btn sm ghost feat-sb-link" to={projectPath(slug, 'storyboards') + '?edit=' + encodeURIComponent(f.storyboard.slug)}>
                Open storyboard
              </Link>
            )}
          </div>
          <p className="feat-stamp">
            Created {timeAgo(f.createdAt)} · updated {timeAgo(f.updatedAt)}
          </p>

          <DetailsSection feature={f} imageFor={imageFor} onSave={(details) => patch({ details }, 'Details saved')} onUpload={upload} />
          <ImagesSection feature={f} onUpload={upload} onOpen={setLightbox} onDelete={(img) => run(featuresApi.deleteImage(slug, f.id, img.id), 'Deleted ' + img.name)} />
          <TasksSection slug={slug} feature={f} setFeature={(next) => feat.setData(next)} run={run} />
        </div>
      )}
      {f && lightbox !== null && images[lightbox] && <Lightbox images={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />}
    </Drawer>
  );
}

function DetailsSection({ feature, imageFor, onSave, onUpload }: { feature: Feature; imageFor: (src: string) => { url: string; title?: string; onOpen?: () => void } | null; onSave: (v: string) => Promise<boolean>; onUpload: (files: File[]) => Promise<FeatureImage[]> }) {
  const { details } = useFeatAccess();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(feature.details);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setText(feature.details);
  }, [feature.details, editing]);

  const insertImages = async (files: File[]) => {
    const el = ta.current;
    const at = el ? el.selectionStart : text.length;
    setBusy(true);
    const added = await onUpload(files);
    setBusy(false);
    if (!added.length) return;
    const md = added.map((i) => i.markdown).join('\n');
    setText((t) => t.slice(0, at) + (at > 0 && t[at - 1] !== '\n' ? '\n' : '') + md + '\n' + t.slice(at));
  };
  const save = async () => {
    setBusy(true);
    const ok = await onSave(text);
    setBusy(false);
    if (ok) setEditing(false); // a failed save stays in edit mode with the text kept
  };
  const cancel = () => {
    setText(feature.details);
    setEditing(false);
  };

  return (
    <section className="feat-section" aria-labelledby="feat-details-h">
      <div className="feat-section-head">
        <h3 id="feat-details-h">Details</h3>
        {!editing && details && (
          <button type="button" className="btn xs" onClick={() => setEditing(true)} data-testid="feature-edit-details">
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="feat-editor">
          <textarea
            ref={ta}
            autoFocus
            value={text}
            rows={12}
            aria-label="Details (markdown)"
            aria-describedby="feat-details-hint"
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((x) => x.type.startsWith('image/'));
              if (files.length) {
                e.preventDefault();
                void insertImages(files);
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) e.preventDefault();
            }}
            onDrop={(e) => {
              const files = [...e.dataTransfer.files];
              if (files.length) {
                e.preventDefault();
                e.stopPropagation();
                void insertImages(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                cancel();
              }
            }}
          />
          <p id="feat-details-hint" className="hint">
            Markdown: # heading, **bold**, *italic*, - list, - [ ] checklist, `code`, [link](https://…). Paste or drop an image to attach it here. Ctrl+Enter saves, Esc cancels.
          </p>
          <div className="row">
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn sm ghost" onClick={cancel}>
              Cancel
            </button>
            {busy && <span className="muted">Working…</span>}
          </div>
        </div>
      ) : feature.details.trim() ? (
        <Markdown text={feature.details} image={imageFor} className="feat-md" />
      ) : (
        <p className="feat-none">No details yet. Edit to describe the feature, why it matters and how it should work.</p>
      )}
    </section>
  );
}

function ImagesSection({ feature, onUpload, onOpen, onDelete }: { feature: Feature; onUpload: (files: File[]) => Promise<FeatureImage[]>; onOpen: (i: number) => void; onDelete: (img: FeatureImage) => Promise<unknown> }) {
  const input = useRef<HTMLInputElement>(null);
  const copy = useCopy();
  const [over, setOver] = useState(false);
  const full = feature.images.length >= MAX_IMAGES;
  const { details } = useFeatAccess();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void onUpload(files);
  };
  return (
    <section
      className={'feat-section feat-images' + (over ? ' drop' : '')}
      aria-labelledby="feat-images-h"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={details ? onDrop : (e) => e.preventDefault()}
    >
      <div className="feat-section-head">
        <h3 id="feat-images-h">
          Images <span className="feat-count">{feature.images.length}/{MAX_IMAGES}</span>
        </h3>
        <button type="button" className="btn xs" disabled={full || !details} title={details ? undefined : needRole('features.details')} onClick={() => input.current?.click()}>
          Upload
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          data-testid="feature-image-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void onUpload(files);
          }}
        />
      </div>
      {feature.images.length === 0 ? (
        <p className="feat-none feat-dropzone">{details ? 'Drop images here, paste one (Ctrl+V) or upload. PNG, JPEG, WebP or GIF, up to 5 MB each.' : 'No images.'}</p>
      ) : (
        <ul className="feat-thumbs">
          {feature.images.map((img, i) => (
            <li key={img.id} className="feat-thumb">
              <button type="button" className="feat-thumb-img" onClick={() => onOpen(i)} aria-label={'Open ' + img.name}>
                <img src={img.url} alt="" loading="lazy" />
              </button>
              <div className="feat-thumb-meta">
                <span className="feat-thumb-name" title={img.name}>
                  {img.name}
                </span>
                <span className="feat-thumb-size">
                  {img.width && img.height ? img.width + '×' + img.height + ' · ' : ''}
                  {fmtBytes(img.bytes)}
                </span>
              </div>
              <div className="feat-thumb-actions">
                <button type="button" className="btn xs ghost" onClick={() => void copy(img.markdown, 'Markdown copied')} title="Copy the markdown that shows this image in the details" aria-label={'Copy markdown for ' + img.name}>
                  Copy markdown
                </button>
                {details && <ConfirmButton label="Delete" ariaLabel={'Delete ' + img.name} question="Delete image?" onConfirm={() => void onDelete(img)} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Lightbox({ images, index, onIndex, onClose }: { images: FeatureImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const img = images[index];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    // Capture phase on window: runs before (and stops) the drawer's own Escape handler.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
      else return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, images.length, onClose, onIndex]);
  return (
    <div className="overlay center feat-lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className="feat-lightbox-box" role="dialog" aria-modal="true" aria-label={'Image ' + (index + 1) + ' of ' + images.length + ': ' + img.name}>
        <div className="feat-lightbox-head">
          <span className="feat-thumb-name">{img.name}</span>
          <span className="feat-thumb-size">
            {index + 1} / {images.length}
          </span>
          <a className="btn xs ghost" href={img.url + '?download=1'}>
            Download
          </a>
          <button type="button" className="btn xs ghost" onClick={onClose} aria-label="Close image">
            ✕
          </button>
        </div>
        <div className="feat-lightbox-body">
          <button type="button" className="btn sm ghost feat-lb-nav" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous image">
            ‹
          </button>
          <img src={img.url} alt={img.name} />
          <button type="button" className="btn sm ghost feat-lb-nav" disabled={index === images.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next image">
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ tasks

/** Runs an API call, shows its error and refreshes the drawer; resolves whether it worked. */
type Run = (p: Promise<unknown>, msg?: string) => Promise<boolean>;
type MoveFn = (siblings: FeatureTask[], i: number, dir: -1 | 1, parent: string | null) => void;

function TasksSection({ slug, feature, setFeature, run }: { slug: string; feature: Feature; setFeature: (f: Feature) => void; run: Run }) {
  const [title, setTitle] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { edit } = useFeatAccess();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setTitle('');
    if (!(await run(featuresApi.addTask(slug, feature.id, { title: t })))) setTitle((cur) => cur || t);
    input.current?.focus();
  };
  const toggle = async (task: FeatureTask, done: boolean) => {
    // Optimistic: flip it locally, then save.
    const flip = (ts: FeatureTask[]): FeatureTask[] => ts.map((x) => (x.id === task.id ? { ...x, done } : { ...x, subtasks: x.subtasks ? flip(x.subtasks) : x.subtasks }));
    setFeature({ ...feature, tasks: flip(feature.tasks), progress: { ...feature.progress, done: feature.progress.done + (done ? 1 : -1) } });
    try {
      await featuresApi.toggleTask(slug, feature.id, task.id, done);
    } catch (err) {
      toast(errMsg(err));
    }
    void run(Promise.resolve());
  };
  const move: MoveFn = async (siblings, i, dir, parent) => {
    const ids = siblings.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await run(featuresApi.reorderTasks(slug, feature.id, ids, parent));
    requestAnimationFrame(() => focusMove('data-task-move', siblings[i].id, dir));
  };
  return (
    <section className="feat-section" aria-labelledby="feat-tasks-h">
      <div className="feat-section-head">
        <h3 id="feat-tasks-h">Tasks</h3>
        <Progress done={feature.progress.done} total={feature.progress.total} />
      </div>
      {feature.tasks.length > 0 && (
        <ul className="feat-tasks">
          {feature.tasks.map((t, i) => (
            <TaskItem key={t.id} slug={slug} feature={feature} task={t} index={i} siblings={feature.tasks} run={run} onToggle={toggle} onMove={move} />
          ))}
        </ul>
      )}
      {!edit && feature.tasks.length === 0 && <p className="feat-none">No tasks.</p>}
      {edit && (
      <form className="feat-add-task" onSubmit={add}>
        <input ref={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task and press Enter" aria-label="New task title" maxLength={200} data-testid="feature-add-task" />
        <button className="btn sm" disabled={!title.trim()}>
          Add task
        </button>
      </form>
      )}
    </section>
  );
}

function TaskItem({ slug, feature, task, index, siblings, run, onToggle, onMove }: { slug: string; feature: Feature; task: FeatureTask; index: number; siblings: FeatureTask[]; run: Run; onToggle: (t: FeatureTask, done: boolean) => void; onMove: MoveFn }) {
  const isSub = !!task.parentTaskId;
  const [adding, setAdding] = useState(false);
  const [sub, setSub] = useState('');
  const [more, setMore] = useState(false);
  const [note, setNote] = useState(task.note);
  const [assignee, setAssignee] = useState(task.assignee);
  useEffect(() => {
    setNote(task.note);
    setAssignee(task.assignee);
  }, [task.note, task.assignee]);
  const kids = task.subtasks ?? [];
  const name = '“' + task.title + '”';
  const { edit } = useFeatAccess();
  const addSub = async (e: FormEvent) => {
    e.preventDefault();
    const t = sub.trim();
    if (!t) return;
    setSub('');
    if (!(await run(featuresApi.addTask(slug, feature.id, { title: t, parentTaskId: task.id })))) setSub((cur) => cur || t);
  };
  const escClose = (e: ReactKeyboardEvent, close: () => void) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  return (
    <li className={'feat-task' + (isSub ? ' sub' : '') + (task.done ? ' done' : '')} data-testid={isSub ? 'subtask' : 'task'}>
      <div className="feat-task-row">
        <input type="checkbox" checked={task.done} disabled={!edit} title={edit ? undefined : needRole('features.edit')} onChange={(e) => onToggle(task, e.target.checked)} aria-label={'Done: ' + task.title} />
        <InlineText value={task.title} label={isSub ? 'Subtask' : 'Task'} className="feat-task-title" onSave={(title) => run(featuresApi.updateTask(slug, feature.id, task.id, { title }))} />
        {task.assignee && <Badge kind="feat-assignee">{task.assignee}</Badge>}
        {edit && (
        <div className="feat-task-actions">
          <button type="button" className="btn xs ghost" disabled={index === 0} onClick={() => onMove(siblings, index, -1, task.parentTaskId)} aria-label={'Move ' + name + ' up'} data-task-move={task.id + ':-1'}>
            ↑
          </button>
          <button type="button" className="btn xs ghost" disabled={index === siblings.length - 1} onClick={() => onMove(siblings, index, 1, task.parentTaskId)} aria-label={'Move ' + name + ' down'} data-task-move={task.id + ':1'}>
            ↓
          </button>
          {!isSub && (
            <button type="button" className="btn xs ghost" onClick={() => setAdding(!adding)} aria-expanded={adding} aria-label={'Add a subtask to ' + name}>
              + Sub
            </button>
          )}
          <button type="button" className="btn xs ghost" onClick={() => setMore(!more)} aria-expanded={more} aria-label={'Note and assignee of ' + name}>
            Note
          </button>
          <ConfirmButton label="✕" ariaLabel={'Delete ' + name} question={kids.length ? 'Delete with ' + plural(kids.length, 'subtask') + '?' : 'Delete?'} onConfirm={() => void run(featuresApi.deleteTask(slug, feature.id, task.id))} />
        </div>
        )}
      </div>
      {task.note && !more && <Markdown text={task.note} className="feat-task-note" />}
      {more && (
        <form
          className="feat-task-more"
          onSubmit={(e) => {
            e.preventDefault();
            void run(featuresApi.updateTask(slug, feature.id, task.id, { note, assignee })).then((ok) => ok && setMore(false));
          }}
          onKeyDown={(e) => escClose(e, () => setMore(false))}
        >
          <label className="field">
            <span>Note (markdown)</span>
            <textarea rows={3} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>Assignee</span>
            <input value={assignee} maxLength={80} list={ASSIGNEE_LIST} autoComplete="off" onChange={(e) => setAssignee(e.target.value)} placeholder="A project member, or any name" />
          </label>
          <div className="row">
            <button className="btn xs primary">Save</button>
            <button type="button" className="btn xs ghost" onClick={() => setMore(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {(kids.length > 0 || adding) && (
        <ul className="feat-tasks feat-subtasks">
          {kids.map((s, i) => (
            <TaskItem key={s.id} slug={slug} feature={feature} task={s} index={i} siblings={kids} run={run} onToggle={onToggle} onMove={onMove} />
          ))}
          {adding && (
            <li className="feat-task sub">
              <form className="feat-add-task" onSubmit={addSub} onKeyDown={(e) => escClose(e, () => setAdding(false))}>
                <input autoFocus value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Subtask title, Enter to add" aria-label={'New subtask of ' + name} maxLength={200} />
                <button className="btn xs" disabled={!sub.trim()}>
                  Add
                </button>
              </form>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
