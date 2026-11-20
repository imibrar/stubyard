import type { ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from './people';
import { useCopy } from './ui';

/**
 * Shared building blocks of the Providers page (pages/ProvidersPage.tsx): URLs and the list-and-detail pieces
 * used by every provider category (message providers, login providers, …).
 */

/**
 * Deep link into the Providers page: /p/<slug>/providers[/<category>[/<instance>]]. Category ids come from the
 * registry in pages/ProvidersPage.tsx (PROVIDER_CATEGORIES); message categories use the channel name.
 */
export function providersPath(slug: string, category?: string, instance?: string) {
  return `/p/${slug}/providers${category ? `/${category}` : ''}${category && instance ? `/${encodeURIComponent(instance)}` : ''}`;
}

/** Copyable URL chip; safe inside clickable rows (does not select the row). */
export function CopyUrl({ url, label = 'URL copied', className = '' }: { url: string; label?: string; className?: string }) {
  const copy = useCopy();
  return (
    <button
      className={`cred prov-url ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        void copy(url, label);
      }}
      title={`Copy ${url}`}
    >
      <span className="ellipsis">{url}</span>
      <Icon name="copy" size={12} />
    </button>
  );
}

/** One instance in the list column: name + status badges, then preset / labels, then the URL. */
export function InstanceRow({ to, active, title, status, meta, url }: { to: string; active: boolean; title: string; status?: ReactNode; meta?: ReactNode; url?: ReactNode }) {
  const nav = useNavigate();
  return (
    <div className={`prov-item list-row ${active ? 'active' : ''}`} onClick={() => nav(to)}>
      <div className="row nowrap prov-item-top">
        <Link to={to} className="prov-item-name ellipsis" onClick={(e) => e.stopPropagation()} aria-current={active ? 'true' : undefined}>
          {title}
        </Link>
        {status && <div className="row prov-item-status">{status}</div>}
        <span className="prov-item-chev" aria-hidden>
          ›
        </span>
      </div>
      {meta && <div className="row row-meta prov-item-meta">{meta}</div>}
      {url && <div className="prov-item-url">{url}</div>}
    </div>
  );
}

/** Header card of the detail column: back (phones), title, badges, actions, key facts and the section tabs. */
export function DetailHead({
  backTo,
  icon,
  title,
  sub,
  badges,
  actions,
  children,
  sections,
}: {
  backTo: string;
  icon?: ReactNode;
  title: string;
  sub?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  sections?: ReactNode;
}) {
  return (
    <div className="card prov-detail-head">
      <div className="prov-detail-top">
        <Link to={backTo} className="btn sm ghost viewer-back" aria-label="Back to the list">
          ← All
        </Link>
        <div className="prov-detail-title">
          <h2 className="row nowrap">
            {icon}
            <span className="ellipsis">{title}</span>
          </h2>
          {sub && <div className="small faint row">{sub}</div>}
        </div>
        {actions && <div className="row-actions prov-detail-actions">{actions}</div>}
      </div>
      {badges && <div className="row prov-detail-badges">{badges}</div>}
      {children}
      {sections}
    </div>
  );
}

/** Section tabs of the detail column, kept in ?section= so reloads and links keep the section. */
export function useSection<T extends string>(sections: readonly T[]): [T, (s: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('section') as T | null;
  const current = raw && sections.includes(raw) ? raw : sections[0];
  const set = (s: T) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (s === sections[0]) n.delete('section');
        else n.set('section', s);
        return n;
      },
      { replace: true },
    );
  return [current, set];
}

export function SectionTabs<T extends string>({ sections, labels, current, onChange, extra }: { sections: readonly T[]; labels: Record<T, ReactNode>; current: T; onChange: (s: T) => void; extra?: Partial<Record<T, ReactNode>> }) {
  return (
    <div className="tabs prov-sections" role="tablist">
      {sections.map((s) => (
        <button key={s} type="button" role="tab" aria-selected={current === s} className={`tab ${current === s ? 'active' : ''}`} onClick={() => onChange(s)}>
          {labels[s]}
          {extra?.[s]}
        </button>
      ))}
    </div>
  );
}
