/**
 * Navigation registry: the single source of truth for project sections, their groups, icons, routes, tabs and
 * palette keywords. The shell (sidebar / top bar / mobile nav), the command palette, breadcrumbs and page tab strips
 * read from here, so a new section or tab is one entry in this file.
 *
 * Routes are unchanged from 0.14: every path below is relative to /p/:slug ('' = the project home).
 * Old tab ids keep working: each TabDef can list aliases that resolve to it (see resolveTab).
 */
import type { Overview } from './api';
import type { IconName } from './components/people';

export interface TabDef {
  /** Canonical id, as written in ?tab= (or the path segment when `path` is set). */
  id: string;
  label: string;
  /** Older ids that resolve to this tab (e.g. storyboards ?tab=data-sets → library). */
  aliases?: string[];
  /** Extra query parameters this tab implies when reached through an alias, e.g. { lib: 'data-sets' }. */
  aliasParams?: Record<string, Record<string, string>>;
  /** Project-relative path when the tab is a route of its own instead of ?tab= (providers categories, chat sections, payments gateways). */
  path?: string;
  keywords?: string;
}

export interface NavItem {
  id: string;
  label: string;
  /** Project-relative path ('' = overview). */
  path: string;
  icon: IconName;
  keywords: string;
  /** Exact match for the active state (overview only). */
  end?: boolean;
  /** Other path prefixes that should highlight this item (e.g. /providers/payments highlights Payments). */
  alsoActive?: string[];
  /** Badge shown next to the item: unread counts are accented, plain counts are faint hints. */
  count?: (ov: Overview) => { n: number; kind: 'unread' | 'hint'; title?: string } | null;
  /** First-level tabs of the section (palette entries "Section > Tab", Tabs strips). */
  tabs?: TabDef[];
  /** Name of the query parameter that holds the tab (default 'tab'). */
  tabParam?: string;
}

export interface NavGroup {
  id: 'inbox' | 'simulate' | 'automate' | 'tools' | 'project';
  label: string;
  items: NavItem[];
}

export interface GlobalNavItem {
  id: string;
  label: string;
  path: string;
  icon: IconName;
  keywords: string;
  external?: boolean;
  title?: string;
  tabs?: TabDef[];
}

const unreadOfUsers = (ov: Overview) => ov.users.reduce((n, u) => n + (u.inbox ? u.inbox.email.unread + u.inbox.sms.unread + u.inbox.whatsapp.unread : 0), 0);
const unassignedUnread = (ov: Overview) => ov.unassigned.email.unread + ov.unassigned.sms.unread + ov.unassigned.whatsapp.unread;

// ---------------- tab registries (ids are the ones the pages already use) ----------------

export const PROVIDER_TABS: TabDef[] = [
  { id: 'email', label: 'Email', path: 'providers/email', keywords: 'smtp sendgrid mailgun ses' },
  { id: 'sms', label: 'SMS & Verify', path: 'providers/sms', keywords: 'twilio vonage verify' },
  { id: 'whatsapp', label: 'WhatsApp', path: 'providers/whatsapp', keywords: 'meta cloud api 360dialog' },
  { id: 'login', label: 'Login (OAuth / OIDC)', path: 'providers/login', keywords: 'oauth oidc google microsoft github apple sso' },
  { id: 'payments', label: 'Payment gateways', path: 'providers/payments', keywords: 'stripe paypal paytabs hyperpay moyasar tap tabby tamara checkout aps myfatoorah geidea jazzcash easypaisa' },
  { id: 'llm', label: 'LLM APIs', path: 'providers/llm', keywords: 'openai anthropic gemini ai' },
  { id: 'push', label: 'Push (FCM / APNs)', path: 'providers/push', keywords: 'fcm apns firebase' },
];

export const PAYMENT_TABS: TabDef[] = [
  { id: 'payments', label: 'Payments', keywords: 'checkouts list' },
  { id: 'gateways', label: 'Gateways', path: 'providers/payments', keywords: 'payment providers instances' },
  { id: 'rules', label: 'Outcome rules', keywords: 'decline 3ds failure' },
  { id: 'pages', label: 'Checkout pages', keywords: 'hosted realistic classic language timings coverage' },
  { id: 'paypal', label: 'Subscriptions & disputes', keywords: 'paypal billing subscription dispute' },
  { id: 'lint', label: 'Integration checks', keywords: 'lint checks problems' },
];

/** Storyboards: 4 tabs; Library holds data sets, login recipes and page snapshots (?lib=); Import / export is a header action (?tab=bundle). */
export const STORYBOARD_TABS: TabDef[] = [
  { id: 'storyboards', label: 'Storyboards', keywords: 'editor steps' },
  { id: 'walkthroughs', label: 'Walkthroughs', keywords: 'runs results extension' },
  {
    id: 'library',
    label: 'Library',
    aliases: ['data-sets', 'recipes', 'snapshots'],
    aliasParams: { 'data-sets': { lib: 'data-sets' }, recipes: { lib: 'recipes' }, snapshots: { lib: 'snapshots' } },
    keywords: 'data sets login recipes page snapshots',
  },
  { id: 'cleanup', label: 'Cleanup', keywords: 'created records delete' },
];
export const STORYBOARD_LIBRARY: TabDef[] = [
  { id: 'data-sets', label: 'Data sets', keywords: 'form data entries' },
  { id: 'recipes', label: 'Login recipes', keywords: 'login role' },
  { id: 'snapshots', label: 'Page snapshots', keywords: 'snapshot forms' },
];
/** Storyboards views reached outside the tab strip (header action). */
export const STORYBOARD_EXTRA_VIEWS: TabDef[] = [{ id: 'bundle', label: 'Import / export', keywords: 'bundle json import export' }];

export const PUSH_TABS: TabDef[] = [
  { id: 'inbox', label: 'Inbox', keywords: 'notifications' },
  { id: 'devices', label: 'Devices', keywords: 'tokens' },
  { id: 'faults', label: 'Faults', keywords: 'errors unregistered' },
  { id: 'connect', label: 'Connect', keywords: 'setup sdk' },
];

export const LLM_TABS: TabDef[] = [
  { id: 'script', label: 'Script', keywords: 'responses' },
  { id: 'calls', label: 'Calls', keywords: 'requests log' },
  { id: 'recording', label: 'Recording', keywords: 'record replay' },
  { id: 'connect', label: 'Connect', keywords: 'base url sdk' },
];

export const AUTO_REPLY_TABS: TabDef[] = [
  { id: 'rules', label: 'Rules', keywords: 'reply echo stop' },
  { id: 'activity', label: 'Activity', keywords: 'pending sent' },
  { id: 'personas', label: 'Personas', keywords: 'ai persona conversation' },
];

export const WEBHOOK_TABS: TabDef[] = [
  { id: 'receive', label: 'Receive', keywords: 'endpoints schema' },
  { id: 'send', label: 'Send', keywords: 'templates sequences signing' },
];

export const CHAT_TABS: TabDef[] = [
  { id: 'chat', label: 'Conversations', path: 'chat', keywords: 'conversation' },
  { id: 'agents', label: 'Agents', path: 'chat/agents', keywords: 'agent tools' },
  { id: 'prompts', label: 'Saved prompts', path: 'chat/prompts', keywords: 'prompt expectations' },
  { id: 'matrix', label: 'Matrix', path: 'chat/matrix', keywords: 'compare models' },
];

export const MCP_TABS: TabDef[] = [
  { id: 'tools', label: 'Tools' },
  { id: 'resources', label: 'Resources' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'log', label: 'Log' },
  { id: 'checks', label: 'Checks' },
  { id: 'saved', label: 'Saved calls' },
];

/** /p/:slug/settings?tab= */
export const SETTINGS_TABS: TabDef[] = [
  { id: 'general', label: 'General', keywords: 'name description otp regex roles password phone prefix email domain app origins' },
  { id: 'data', label: 'Data', keywords: 'retention auto reset export import' },
  { id: 'checks', label: 'Checks & time', keywords: 'content checks clock offsets time travel reset rules' },
  { id: 'danger', label: 'Danger zone', keywords: 'reset data delete project' },
];

/** /system?tab= */
export const SYSTEM_TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', keywords: 'storage versions ports database' },
  { id: 'ai', label: 'AI providers', keywords: 'openai anthropic keys' },
  { id: 'maintenance', label: 'Maintenance', keywords: 'automatic clean-up retention' },
  { id: 'danger', label: 'Danger zone', keywords: 'factory reset' },
];

// ---------------- project navigation ----------------

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'inbox',
    label: 'Inbox',
    items: [
      { id: 'overview', label: 'Overview', path: '', end: true, icon: 'home', keywords: 'home dashboard project' },
      {
        id: 'users',
        label: 'Users',
        path: 'users',
        alsoActive: ['users/'],
        icon: 'users',
        keywords: 'test users inbox codes otp',
        count: (ov) => {
          const n = unreadOfUsers(ov);
          return n ? { n, kind: 'unread', title: 'Unread messages' } : null;
        },
      },
      {
        id: 'unassigned',
        label: 'Unassigned',
        path: 'unassigned',
        icon: 'inbox',
        keywords: 'unassigned inbox unknown recipient',
        count: (ov) => {
          const n = unassignedUnread(ov);
          return n ? { n, kind: 'unread' } : null;
        },
      },
      { id: 'push', label: 'Push', path: 'push', icon: 'bell', keywords: 'push notifications fcm apns devices', tabs: PUSH_TABS },
      {
        id: 'authenticator',
        label: 'Authenticator',
        path: 'authenticator',
        icon: 'key',
        keywords: '2fa totp codes google authenticator',
        count: (ov) => ({ n: ov.authenticators.length, kind: 'hint' }),
      },
    ],
  },
  {
    id: 'simulate',
    label: 'Simulate',
    items: [
      {
        id: 'providers',
        label: 'Providers',
        path: 'providers',
        icon: 'plug',
        keywords: 'providers instances email sms whatsapp login',
        tabs: PROVIDER_TABS,
        count: (ov) => {
          const c = ov.providerCounts;
          const n = c ? Object.values(c).reduce((a, b) => a + b, 0) : ov.providers.length;
          const title = c ? Object.entries(c).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' · ') : undefined;
          return { n, kind: 'hint', title };
        },
      },
      { id: 'payments', label: 'Payments', path: 'payments', alsoActive: ['providers/payments'], icon: 'card', keywords: 'payments stripe paypal checkout refunds webhooks', tabs: PAYMENT_TABS },
      { id: 'storage', label: 'Storage', path: 'storage', icon: 'database', keywords: 's3 files buckets storage' },
      { id: 'mocks', label: 'API mocks', path: 'mocks', icon: 'braces', keywords: 'api mocks http stubs' },
      { id: 'llm', label: 'LLM mocks', path: 'llm', icon: 'sparkle', keywords: 'llm openai anthropic script', tabs: LLM_TABS },
      { id: 'webhooks', label: 'Webhooks', path: 'webhooks', icon: 'webhook', keywords: 'webhooks receive send signed', tabs: WEBHOOK_TABS },
    ],
  },
  {
    id: 'automate',
    label: 'Automate',
    items: [
      { id: 'auto-replies', label: 'Auto-replies', path: 'auto-replies', icon: 'reply', keywords: 'auto replies rules personas', tabs: AUTO_REPLY_TABS },
      { id: 'scheduled', label: 'Scheduled', path: 'scheduled', icon: 'clock', keywords: 'send later repeat schedule' },
      { id: 'storyboards', label: 'Storyboards', path: 'storyboards', icon: 'list-checks', keywords: 'storyboards walkthroughs manual tests', tabs: STORYBOARD_TABS },
      { id: 'runs', label: 'Test runs', path: 'runs', icon: 'play', keywords: 'runs parallel workers' },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    items: [
      { id: 'mcp-tester', label: 'MCP tester', path: 'mcp-tester', icon: 'terminal', keywords: 'mcp tools resources prompts checks', tabs: MCP_TABS },
      { id: 'chat', label: 'AI chat', path: 'chat', icon: 'chat', keywords: 'chat agents prompts llm', tabs: CHAT_TABS },
    ],
  },
  {
    id: 'project',
    label: 'Project',
    items: [
      { id: 'traffic', label: 'Traffic log', path: 'traffic', icon: 'activity', keywords: 'traffic requests log smtp' },
      { id: 'setup', label: 'Connect your app', path: 'setup', icon: 'code', keywords: 'setup connect snippets doctor' },
      { id: 'settings', label: 'Settings', path: 'settings', icon: 'settings', keywords: 'project settings', tabs: SETTINGS_TABS },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** "New" actions (nav split button and palette): project-relative path with ?new= (the page opens its own dialog). */
export const NEW_ACTIONS: { label: string; path: string; keywords: string }[] = [
  { label: 'Add user', path: '?new=user', keywords: 'create test user' },
  { label: 'Generate users', path: '?new=generate', keywords: 'create many test users roles' },
  { label: 'Add provider', path: 'providers?new=provider', keywords: 'create provider instance' },
  { label: 'New API mock', path: 'mocks?new=mock', keywords: 'create http stub' },
  { label: 'New storyboard', path: 'storyboards?edit=new', keywords: 'create walkthrough' },
  { label: 'New webhook endpoint', path: 'webhooks?tab=receive&new=endpoint', keywords: 'create receive url' },
];

/** Outside a project: one "workspace" menu. */
export const GLOBAL_NAV: GlobalNavItem[] = [
  { id: 'projects', label: 'All projects', path: '/', icon: 'folder', keywords: 'projects home' },
  { id: 'global-traffic', label: 'Global traffic log', path: '/traffic', icon: 'globe', keywords: 'traffic requests all projects' },
  { id: 'system', label: 'System', path: '/system', icon: 'server', keywords: 'storage retention versions factory reset ai providers', tabs: SYSTEM_TABS },
  { id: 'https', label: 'HTTPS setup', path: '/https', icon: 'lock', keywords: 'https certificate ca tls' },
  {
    id: 'agent-guide',
    label: 'Agent guide',
    path: '/api/agent-guide',
    icon: 'external',
    keywords: 'ai agent markdown guide',
    external: true,
    title: "Markdown guide for AI agents, with this stubyard's addresses",
  },
];

// ---------------- helpers ----------------

/** Absolute URL of a project section (or a project-relative path). */
export const projectPath = (slug: string, path: string) => `/p/${slug}${path ? `/${path}` : ''}`;

/** Absolute URL of a section tab: its own route when it has one, otherwise ?tab= (the first tab has no query). */
export function tabHref(slug: string, item: Pick<NavItem, 'path' | 'tabs' | 'tabParam'>, tab: TabDef): string {
  if (tab.path !== undefined) return projectPath(slug, tab.path);
  const first = item.tabs?.[0]?.id;
  return tab.id === first ? projectPath(slug, item.path) : `${projectPath(slug, item.path)}?${item.tabParam ?? 'tab'}=${encodeURIComponent(tab.id)}`;
}

/** The nav item (and its group) for a project-relative path such as "payments/abc" or "providers/payments". */
export function findNavItem(relPath: string): { group: NavGroup; item: NavItem } | null {
  const p = relPath.replace(/^\/+|\/+$/g, '');
  let best: { group: NavGroup; item: NavItem; len: number } | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const prefixes = [item.path, ...(item.alsoActive ?? [])];
      for (const pre of prefixes) {
        const hit = item.end || pre === '' ? p === pre : p === pre || p.startsWith(pre.endsWith('/') ? pre : `${pre}/`);
        if (hit && (!best || pre.length > best.len)) best = { group, item, len: pre.length };
      }
    }
  }
  return best && { group: best.group, item: best.item };
}

/**
 * Resolve a raw tab value (from ?tab= or a path) against a registry: canonical ids, then aliases; unknown or empty
 * values fall back to the first tab (never a blank page). `params` are the extra query values an alias implies.
 */
export function resolveTab(tabs: readonly TabDef[], raw: string | null | undefined): { id: string; params: Record<string, string>; alias: boolean } {
  const fallback = { id: tabs[0]?.id ?? '', params: {}, alias: false };
  if (!raw) return fallback;
  const direct = tabs.find((t) => t.id === raw);
  if (direct) return { id: direct.id, params: {}, alias: false };
  const viaAlias = tabs.find((t) => t.aliases?.includes(raw));
  if (viaAlias) return { id: viaAlias.id, params: viaAlias.aliasParams?.[raw] ?? {}, alias: true };
  return fallback;
}

/** Recently visited destinations (palette "Recent" group). */
const RECENT_KEY = 'stubyard.recent';
export interface RecentEntry {
  path: string;
  label: string;
  group: string;
}
export function readRecent(): RecentEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? (v as RecentEntry[]).slice(0, 6) : [];
  } catch {
    return [];
  }
}
export function pushRecent(e: RecentEntry) {
  try {
    const next = [e, ...readRecent().filter((r) => r.path !== e.path)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}
