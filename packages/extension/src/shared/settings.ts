// The panel's few local settings in chrome.storage.local (design §6.3). Everything else lives in stubyard.
// The service worker never reads them; the panel does, and survives being closed and reopened.

export const DEFAULT_API_URL = 'http://localhost:4000';

export interface ActiveWalkthrough {
  project: string;
  id: string;
  /**
   * The page origins its on-page widget shows on: the run's origin and the project's appOrigins
   * (docs/design/floating-widget.md). Missing for runs opened by an older panel: the panel fills it in.
   */
  origins?: string[];
}

export interface Settings {
  /** stubyard base URL, without a trailing slash. */
  apiUrl: string;
  /** The project last used (or chosen in Settings) for an app origin. */
  lastProjectByOrigin: Record<string, string>;
  /** The walkthrough open in each browser window (keyed by window id). */
  activeWalkthroughByWindow: Record<string, ActiveWalkthrough>;
  /** The name put on sign-offs. */
  signedOffBy: string;
  /** Settings switch "Show the step widget on app pages" (on by default). */
  widgetEnabled: boolean;
  /** Settings "Hidden on these sites": page origins where the widget does not show by itself. */
  widgetHiddenOrigins: string[];
}

export const SETTINGS_KEYS = ['apiUrl', 'lastProjectByOrigin', 'activeWalkthroughByWindow', 'signedOffBy', 'widgetEnabled', 'widgetHiddenOrigins'] as const;

export const defaultSettings = (): Settings => ({ apiUrl: DEFAULT_API_URL, lastProjectByOrigin: {}, activeWalkthroughByWindow: {}, signedOffBy: '', widgetEnabled: true, widgetHiddenOrigins: [] });

/** Whether a chrome.storage change touches the settings (other keys, such as the widget's placement, do not). */
export const touchesSettings = (changes: Record<string, unknown>): boolean => SETTINGS_KEYS.some((k) => k in changes);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Settings from whatever is stored (missing or malformed values fall back to the defaults). */
export function withDefaults(raw: unknown): Settings {
  const s = defaultSettings();
  if (!isRecord(raw)) return s;
  if (typeof raw.apiUrl === 'string') s.apiUrl = normalizeApiUrl(raw.apiUrl) ?? DEFAULT_API_URL;
  if (isRecord(raw.lastProjectByOrigin)) {
    for (const [k, v] of Object.entries(raw.lastProjectByOrigin)) if (typeof v === 'string' && v) s.lastProjectByOrigin[k] = v;
  }
  if (isRecord(raw.activeWalkthroughByWindow)) {
    for (const [k, v] of Object.entries(raw.activeWalkthroughByWindow)) {
      if (!isRecord(v) || typeof v.project !== 'string' || typeof v.id !== 'string') continue;
      const origins = Array.isArray(v.origins) ? v.origins.filter((o): o is string => typeof o === 'string' && !!o) : null;
      s.activeWalkthroughByWindow[k] = { project: v.project, id: v.id, ...(origins ? { origins } : {}) };
    }
  }
  if (typeof raw.signedOffBy === 'string') s.signedOffBy = raw.signedOffBy;
  if (typeof raw.widgetEnabled === 'boolean') s.widgetEnabled = raw.widgetEnabled;
  if (Array.isArray(raw.widgetHiddenOrigins)) {
    for (const o of raw.widgetHiddenOrigins) {
      const norm = typeof o === 'string' ? pageOrigin(o) : null;
      if (norm && !s.widgetHiddenOrigins.includes(norm)) s.widgetHiddenOrigins.push(norm);
    }
  }
  return s;
}

/**
 * A typed stubyard URL as a base URL: "localhost:4000" → "http://localhost:4000"; a trailing slash is dropped.
 * Null when it is not an http(s) URL.
 */
export function normalizeApiUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Whether a URL is outside localhost/127.0.0.1. Since extension 0.1.1 the manifest grants <all_urls> (needed by
 * chrome.tabs.captureVisibleTab for screenshots), so the follow-up permission check/request succeeds at once.
 */
export function needsHostPermission(url: string): boolean {
  try {
    const u = new URL(url);
    return !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
  } catch {
    return true;
  }
}

/** The match pattern of a URL's origin, for chrome.permissions ("https://app.test/*"; the port is not part of it). */
export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

/** The origin of an http(s) page URL; null for chrome://, file:, about: and the like. */
export function pageOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Storage (chrome.storage.local by default; tests pass a fake area)

export interface SettingsArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const localArea = (): SettingsArea => chrome.storage.local as unknown as SettingsArea;

export async function loadSettings(area: SettingsArea = localArea()): Promise<Settings> {
  return withDefaults(await area.get([...SETTINGS_KEYS]));
}

export async function saveSettings(patch: Partial<Settings>, area: SettingsArea = localArea()): Promise<Settings> {
  const next = withDefaults({ ...(await area.get([...SETTINGS_KEYS])), ...patch });
  await area.set({ ...patch, ...(patch.apiUrl !== undefined ? { apiUrl: next.apiUrl } : {}) });
  return next;
}

/** Remember (or with null forget) the project used for an app origin. */
export async function rememberProject(origin: string, project: string | null, area: SettingsArea = localArea()): Promise<Settings> {
  const s = await loadSettings(area);
  const map = { ...s.lastProjectByOrigin };
  if (project) map[origin] = project;
  else delete map[origin];
  return saveSettings({ lastProjectByOrigin: map }, area);
}

/** Set (or with null clear) the walkthrough open in a window. */
export async function setActiveWalkthrough(windowId: number, value: ActiveWalkthrough | null, area: SettingsArea = localArea()): Promise<Settings> {
  const s = await loadSettings(area);
  const map = { ...s.activeWalkthroughByWindow };
  if (value) map[String(windowId)] = value;
  else delete map[String(windowId)];
  return saveSettings({ activeWalkthroughByWindow: map }, area);
}
