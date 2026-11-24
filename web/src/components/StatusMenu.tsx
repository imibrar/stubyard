import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useProjects } from '../context';
import { Icon, useLocalState } from './people';
import { useToast } from './ui';

export type Theme = 'dark' | 'light';
export type Density = 'compact' | 'comfortable' | null;

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

/** null = the direction's default (no attribute). */
export function applyDensity(d: Density) {
  if (d) document.documentElement.dataset.density = d;
  else delete document.documentElement.dataset.density;
}

/** Theme, density and desktop-notification preferences (localStorage), applied to <html>. */
export function useShellPrefs() {
  const [theme, setTheme] = useLocalState<Theme>('stubyard.theme', 'dark');
  const [density, setDensity] = useLocalState<Density>('stubyard.density', null);
  const [notify, setNotify] = useLocalState<boolean>('stubyard.notify', false);
  const toast = useToast();
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => applyDensity(density), [density]);
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const cycleDensity = () => setDensity(density === null ? 'compact' : density === 'compact' ? 'comfortable' : null);
  const toggleNotify = async () => {
    if (notify) return setNotify(false);
    if (!('Notification' in window)) return toast('This browser does not support notifications');
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm === 'granted') {
      setNotify(true);
      toast('Desktop notifications on for new codes');
    } else toast('Notifications are blocked for this site');
  };
  return { theme, setTheme, toggleTheme, density, setDensity, cycleDensity, notify, toggleNotify };
}
export type ShellPrefs = ReturnType<typeof useShellPrefs>;

export const densityLabel = (d: Density) => (d === 'compact' ? 'Compact' : d === 'comfortable' ? 'Comfortable' : 'Default');

/** Overall status: 'ok' when live, SMTP and HTTPS are all up. */
export function useOverallStatus() {
  const { system, connected } = useProjects();
  const lines = [
    { id: 'live', label: 'Live updates', ok: connected, detail: connected ? 'connected' : 'reconnecting…' },
    ...(system
      ? [
          { id: 'smtp', label: `SMTP :${system.ports.smtp}`, ok: !!system.mailpit, detail: system.mailpit ? 'up' : 'Mailpit unavailable' },
          { id: 'https', label: `HTTPS :${system.ports.https}`, ok: !!system.tls, detail: system.tls ? 'up' : 'disabled' },
          ...(system.postgres
            ? [
                {
                  id: 'postgres',
                  label: `Postgres${system.postgres.serverVersion ? ` ${system.postgres.serverVersion.split(' ')[0]}` : ''}`,
                  ok: system.postgres.ok,
                  detail: system.postgres.ok
                    ? [system.postgres.latencyMs !== undefined ? `${Math.round(system.postgres.latencyMs)} ms` : 'up', system.postgres.schemaVersion !== undefined ? `schema ${system.postgres.schemaVersion}` : ''].filter(Boolean).join(' · ')
                    : system.postgres.error ?? 'unreachable',
                },
              ]
            : []),
        ]
      : []),
  ];
  return { ok: lines.every((l) => l.ok), lines };
}

/**
 * One status dot that opens a popover: live / SMTP / HTTPS lines (link to /https), notifications, theme and density.
 * `showPrefs` = false shows only the status lines.
 */
export function StatusMenu({ prefs, showPrefs = true, className = '' }: { prefs: ShellPrefs; showPrefs?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { ok, lines } = useOverallStatus();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`menu-wrap status-menu ${className}`} ref={ref}>
      <button type="button" className="icon-btn" aria-expanded={open} aria-haspopup="true" aria-label={`Status: ${ok ? 'all services up' : 'a service is down'}`} title={ok ? 'All services up' : 'A service is down'} onClick={() => setOpen(!open)}>
        <span className={`dot ${ok ? 'on' : 'warn'}`} />
      </button>
      {open && (
        <div className="menu status-pop" role="menu">
          {lines.map((l) => (
            <div key={l.id} className="status-line" role="none">
              <span className={`dot ${l.ok ? 'on' : 'off'}`} aria-hidden />
              <span className="grow">{l.label}</span>
              <span className="sub">{l.detail}</span>
            </div>
          ))}
          <NavLink to="/https" role="menuitem" className="menu-link" onClick={() => setOpen(false)}>
            <Icon name="lock" size={14} /> HTTPS setup
          </NavLink>
          {showPrefs && (
            <>
              <div className="menu-sep" role="separator" />
              <button type="button" role="menuitemcheckbox" aria-checked={prefs.notify} onClick={() => void prefs.toggleNotify()}>
                <Icon name="bell" size={14} /> Desktop notifications <span className="sub">{prefs.notify ? 'on' : 'off'}</span>
              </button>
              <button type="button" role="menuitem" onClick={prefs.toggleTheme}>
                <Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} size={14} /> {prefs.theme === 'dark' ? 'Light' : 'Dark'} theme
              </button>
              <button type="button" role="menuitem" onClick={prefs.cycleDensity}>
                <Icon name="sliders" size={14} /> Density <span className="sub">{densityLabel(prefs.density)}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
