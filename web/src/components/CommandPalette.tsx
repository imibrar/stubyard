import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectMaybe, useProjects } from '../context';
import { GLOBAL_NAV, NAV_GROUPS, projectPath, readRecent, STORYBOARD_EXTRA_VIEWS, STORYBOARD_LIBRARY, tabHref } from '../nav';
import { useFocusTrap } from './layout/hooks';
import { Avatar, Icon, roleStyle } from './people';
import { densityLabel, type ShellPrefs } from './StatusMenu';
import { useCopy } from './ui';

export interface PaletteItem {
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon?: ReactNode;
  run: () => void;
}

/**
 * Ctrl/Cmd+K and "/" palette. Sources: nav sections and their tabs (nav.ts), users, "copy latest code", provider
 * instances, projects, global pages, request-id lookup, actions (Add user, New mock… via ?new=), theme / density,
 * and a "Recent" group when the query is empty. Combobox + listbox with aria-activedescendant; focus trapped and restored.
 */
export function CommandPalette({ onClose, prefs, onShortcuts }: { onClose: () => void; prefs: ShellPrefs; onShortcuts?: () => void }) {
  const project = useProjectMaybe();
  const { projects } = useProjects();
  const nav = useNavigate();
  const copy = useCopy();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  useFocusTrap(boxRef);
  const { theme, toggleTheme, density, cycleDensity } = prefs;

  const items = useMemo(() => {
    const out: PaletteItem[] = [];
    const go = (to: string) => () => nav(to);
    const query = q.trim();
    if (/^[0-9a-z]{19}$/.test(query)) {
      out.push({ group: 'Lookup', label: `Open request ${query}`, icon: <Icon name="activity" />, run: go(`/traffic?log=${query}`) });
    }
    if (!query) {
      for (const r of readRecent()) out.push({ group: 'Recent', label: r.label, hint: r.group, icon: <Icon name="clock" />, run: go(r.path) });
    }
    if (project) {
      const { slug, overview } = project;
      const users = [...overview.users].sort((a, b) => (a.pinned || 999) - (b.pinned || 999));
      for (const u of users) {
        out.push({
          group: 'Test users',
          label: u.name,
          hint: u.email ?? u.phone ?? '',
          keywords: `${u.role} ${u.email ?? ''} ${u.phone ?? ''}`,
          icon: <Avatar user={u} size="sm" />,
          run: go(`/p/${slug}/users/${u.id}`),
        });
      }
      for (const u of users) {
        if (!u.latest?.otp) continue;
        const code = u.latest.otp;
        out.push({
          group: 'Copy code',
          label: `Copy latest code of ${u.name}`,
          hint: code,
          keywords: `otp ${u.role} ${u.email ?? ''}`,
          icon: <span className="role-dot" style={roleStyle(u.role)} />,
          run: () => void copy(code, `Copied ${code}`),
        });
      }
      // Sections and their first-level tabs, from the nav registry.
      for (const g of NAV_GROUPS) {
        for (const it of g.items) {
          out.push({ group: 'Go to', label: it.label, hint: g.label, keywords: `${it.keywords} ${overview.project.name}`, icon: <Icon name={it.icon} />, run: go(projectPath(slug, it.path)) });
          for (const t of it.tabs ?? []) {
            out.push({ group: 'Go to', label: `${it.label} › ${t.label}`, hint: g.label, keywords: `${it.keywords} ${t.keywords ?? ''}`, icon: <Icon name={it.icon} />, run: go(tabHref(slug, it, t)) });
          }
          if (it.id === 'storyboards') {
            for (const t of STORYBOARD_LIBRARY) out.push({ group: 'Go to', label: `Storyboards › Library › ${t.label}`, hint: g.label, keywords: t.keywords, icon: <Icon name={it.icon} />, run: go(`${projectPath(slug, 'storyboards')}?tab=library&lib=${t.id}`) });
            for (const t of STORYBOARD_EXTRA_VIEWS) out.push({ group: 'Go to', label: `Storyboards › ${t.label}`, hint: g.label, keywords: t.keywords, icon: <Icon name={it.icon} />, run: go(`${projectPath(slug, 'storyboards')}?tab=${t.id}`) });
          }
        }
      }
      // Actions: open the page with ?new= (the page opens its own dialog) or the existing route.
      const actions: [string, string, string][] = [
        ['Add user', '?new=user', 'create test user'],
        ['Generate users', '?new=generate', 'create many test users roles'],
        ['Add provider', 'providers?new=provider', 'create provider instance'],
        ['New API mock', 'mocks?new=mock', 'create http stub'],
        ['New storyboard', 'storyboards?edit=new', 'create walkthrough'],
        ['New webhook endpoint', 'webhooks?tab=receive&new=endpoint', 'create receive url'],
      ];
      for (const [label, path, kw] of actions) {
        const [p, qs] = path.split('?');
        out.push({ group: 'Actions', label, keywords: kw, icon: <Icon name="plus" />, run: go(`${projectPath(slug, p)}${qs ? `?${qs}` : ''}`) });
      }
      for (const p of overview.providers) {
        out.push({
          group: 'Provider instances',
          label: p.name,
          hint: `${p.channel} · ${p.slug}`,
          keywords: `provider ${p.preset} ${p.labels.join(' ')}${p.isDefault ? ' default' : ''}`,
          icon: <Icon name="plug" />,
          run: go(`/p/${slug}/providers/${p.channel}/${p.slug}`),
        });
      }
    }
    for (const p of projects ?? []) {
      if (p.slug === project?.slug) continue;
      out.push({ group: 'Switch project', label: p.name, hint: p.slug, icon: <Icon name="folder" />, run: go(`/p/${p.slug}`) });
    }
    for (const g of GLOBAL_NAV) {
      out.push({
        group: 'stubyard',
        label: g.label,
        keywords: g.keywords,
        icon: <Icon name={g.icon} />,
        run: g.external ? () => void window.open(g.path, '_blank', 'noreferrer') : go(g.path),
      });
      for (const t of g.tabs ?? []) out.push({ group: 'stubyard', label: `${g.label} › ${t.label}`, keywords: `${g.keywords} ${t.keywords ?? ''}`, icon: <Icon name={g.icon} />, run: go(t.id === g.tabs![0].id ? g.path : `${g.path}?tab=${t.id}`) });
    }
    out.push(
      { group: 'Preferences', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, keywords: 'theme dark light', icon: <Icon name={theme === 'dark' ? 'sun' : 'moon'} />, run: toggleTheme },
      { group: 'Preferences', label: `Density: ${densityLabel(density)} (switch)`, keywords: 'density compact comfortable', icon: <Icon name="sliders" />, run: cycleDensity },
    );
    if (onShortcuts) out.push({ group: 'Preferences', label: 'Keyboard shortcuts', keywords: 'keys help ?', icon: <Icon name="keyboard" />, run: onShortcuts });
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return out;
    return out.filter((i) => {
      const hay = `${i.label} ${i.hint ?? ''} ${i.keywords ?? ''} ${i.group}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [q, project, projects, nav, copy, theme, toggleTheme, density, cycleDensity, onShortcuts]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Home' && e.ctrlKey) {
      setActive(0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[active]);
    } else if (e.key === 'Escape') onClose();
  };

  let lastGroup = '';
  const optId = (idx: number) => `${listId}-o${idx}`;
  return (
    <div className="overlay top palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={boxRef}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a user, role, email, page, action or request id…"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? optId(active) : undefined}
          aria-label="Search"
        />
        <div className="palette-list" ref={listRef} id={listId} role="listbox" aria-label="Results">
          {items.length === 0 && <div className="empty small">No matches</div>}
          {items.map((i, idx) => {
            const head = i.group !== lastGroup ? (
              <div className="palette-group" role="presentation">
                {(lastGroup = i.group)}
              </div>
            ) : null;
            return (
              <div key={`${i.group}-${i.label}-${idx}`} role="presentation">
                {head}
                <div id={optId(idx)} role="option" aria-selected={idx === active} className={`palette-item ${idx === active ? 'active' : ''}`} onMouseMove={() => setActive(idx)} onClick={() => run(i)}>
                  {i.icon}
                  <span className="ellipsis">{i.label}</span>
                  {i.hint && <span className="hint ellipsis">{i.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>1</kbd>–<kbd>9</kbd> pinned users
          </span>
          <span>
            <kbd>g</kbd> then <kbd>o</kbd>/<kbd>u</kbd>/<kbd>t</kbd>… go to
          </span>
          <span>
            <kbd>?</kbd> shortcuts
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
