import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { resolveTab, type TabDef } from '../../nav';
import { useMediaQuery } from './hooks';

export interface SettingsSection extends TabDef {
  /** Danger zone: rendered last and marked. */
  danger?: boolean;
  /** Link out instead of a section (e.g. System → HTTPS setup). */
  href?: string;
}

/**
 * Settings template: section nav (vertical list from 1024 px, a select below) and one section at a time.
 * The section lives in ?tab= (configurable); unknown values fall back to the first section.
 */
export function SettingsLayout({ sections, value, onChange, children, label = 'Settings sections', className = '' }: { sections: SettingsSection[]; value: string; onChange: (id: string) => void; children: ReactNode; label?: string; className?: string }) {
  const wide = useMediaQuery('(width >= 1024px)');
  const own = sections.filter((s) => !s.href);
  return (
    <div className={`settings-layout ${className}`}>
      {wide ? (
        <nav className="settings-nav" aria-label={label}>
          {sections.map((s) =>
            s.href ? (
              <Link key={s.id} className="settings-nav-item link-out" to={s.href}>
                {s.label} <span aria-hidden>↗</span>
              </Link>
            ) : (
              <button key={s.id} type="button" className={`settings-nav-item ${s.danger ? 'danger' : ''} ${s.id === value ? 'active' : ''}`} aria-current={s.id === value ? 'page' : undefined} onClick={() => onChange(s.id)}>
                {s.label}
              </button>
            ),
          )}
        </nav>
      ) : (
        <label className="settings-select">
          <span className="settings-select-label">Section</span>
          <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
            {own.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="settings-body" role="region" aria-label={own.find((s) => s.id === value)?.label}>
        {children}
      </div>
    </div>
  );
}

/** ?tab= backed section state for SettingsLayout (and any page with query tabs). Default tab = no parameter. */
export function useQueryTab(tabs: readonly TabDef[], param = 'tab'): [string, (id: string) => void, Record<string, string>] {
  const [params, setParams] = useSearchParams();
  const r = resolveTab(tabs, params.get(param));
  const set = (id: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id === tabs[0]?.id) n.delete(param);
        else n.set(param, id);
        return n;
      },
      { replace: true },
    );
  return [r.id, set, r.params];
}
