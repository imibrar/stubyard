import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { pushApi, pushBase, STATUS_KIND, type NotificationQuery, type PushDevice, type PushNotification } from '../pushApi';
import { Icon } from './people';
import { LogDrawer } from './TrafficLog';
import { Badge, CodeBlock, Drawer, Empty, ErrorBox, timeAgo, useTick, useToast } from './ui';
import '../styles/push.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Reloads on push.changed / project.reset. */
export function usePushReload(slug: string, fn: () => void) {
  const reload = useDebounced(fn, 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'push.changed' || e.type === 'project.reset') reload();
  });
}

export function useNotifications(slug: string, q: NotificationQuery) {
  const key = JSON.stringify(q);
  const path = `${pushBase(slug)}/notifications?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString()}`;
  const r = useFetch<PushNotification[]>(path, [slug, key]);
  usePushReload(slug, () => void r.reload());
  return r;
}

const platformLabel = { android: 'Android', ios: 'iOS', web: 'Web' } as const;

/** One notification as a list row: title, body, who, when, status. */
export function PushRow({ n, active, onOpen }: { n: PushNotification; active?: boolean; onOpen: () => void }) {
  return (
    <button className={`push-row list-row ${active ? 'active' : ''} ${n.openedAt || n.status !== 'delivered' ? '' : 'unread'}`} onClick={onOpen}>
      <span className={`push-app ${n.provider}`} aria-hidden>
        {n.provider === 'apns' ? 'A' : 'F'}
      </span>
      <span className="push-row-main">
        <span className="row nowrap push-row-top">
          <strong className="ellipsis grow">{n.title ?? (n.silent ? 'Silent push' : n.body ?? '(no title)')}</strong>
          <span className="faint small nowrap" title={n.createdAt}>
            {timeAgo(n.createdAt)}
          </span>
        </span>
        {n.title && n.body && <span className="ellipsis small push-row-body">{n.body}</span>}
        <span className="row push-row-meta small">
          {n.status !== 'delivered' && <Badge kind={STATUS_KIND[n.status]}>{n.status.replace('_', ' ')}</Badge>}
          {n.errorCode && <code className="small">{n.errorCode}</code>}
          {n.silent && <Badge>data</Badge>}
          <span className="faint ellipsis">
            {n.user?.name ?? 'Unassigned'} · {n.device ? platformLabel[n.device.platform] : n.targetKind === 'token' ? 'device' : n.target}
          </span>
          {n.run && <Badge kind="accent">run {n.run}</Badge>}
          {n.lint.length > 0 && (
            <span className="push-lint-n" title={n.lint.map((l) => l.message).join(' · ')}>
              {n.lint.length} lint
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** Lock-screen style preview for iOS and Android. */
export function LockPreview({ n }: { n: PushNotification }) {
  const ios = n.device?.platform === 'ios' || (!n.device && n.provider === 'apns');
  if (n.silent)
    return (
      <div className="push-phone silent">
        <p className="small muted">Silent / data-only push: nothing is shown, the app handles it in the background.</p>
      </div>
    );
  return (
    <div className={`push-phone ${ios ? 'ios' : 'android'}`} aria-label={`${ios ? 'iOS' : 'Android'} preview`}>
      <div className="push-phone-time">{new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      <div className="push-bubble">
        <div className="row nowrap push-bubble-head">
          <span className={`push-app sm ${n.provider}`} aria-hidden>
            {n.provider === 'apns' ? 'A' : 'F'}
          </span>
          <span className="grow small ellipsis">{ios ? (n.instance?.slug ?? 'App').toUpperCase() : (n.instance?.slug ?? 'App')}</span>
          <span className="faint small">now</span>
        </div>
        {n.title && <div className="push-bubble-title">{n.title}</div>}
        {n.body && <div className="push-bubble-body">{n.body}</div>}
        {n.image && <div className="faint small ellipsis">🖼 {n.image}</div>}
        {n.badge !== null && ios && <span className="push-badge-dot">{n.badge}</span>}
      </div>
    </div>
  );
}

/** Detail of one notification (drawer): preview, data, headers, raw, lint, Open. */
export function PushDetail({ slug, id, onClose }: { slug: string; id: string; onClose: () => void }) {
  const r = useFetch<PushNotification>(`${pushBase(slug)}/notifications/${encodeURIComponent(id)}`, [slug, id]);
  usePushReload(slug, () => void r.reload());
  const toast = useToast();
  const [log, setLog] = useState<string | null>(null);
  const n = r.data;
  const open = async () => {
    try {
      const o = await pushApi.open(slug, id);
      toast(o.tap ? `Tapped: opens ${o.tap.kind} ${o.tap.value}` : 'Tapped (no deep link in the push)');
      r.reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  return (
    <Drawer
      title={n?.title ?? (n?.silent ? 'Silent push' : 'Push notification')}
      onClose={onClose}
      actions={
        n && (
          <button className="btn sm primary" onClick={() => void open()} disabled={n.status !== 'delivered' && n.status !== 'collapsed'}>
            {n.openedAt ? 'Tap again' : 'Tap (open)'}
          </button>
        )
      }
    >
      <ErrorBox error={r.error} />
      {n && (
        <div className="stack push-detail">
          <div className="row">
            <Badge kind={STATUS_KIND[n.status]}>{n.status.replace('_', ' ')}</Badge>
            {n.errorCode && <code>{n.errorCode}</code>}
            <Badge>{n.provider === 'fcm' ? 'FCM' : 'APNs'}</Badge>
            {n.pushType && <Badge>{n.pushType}</Badge>}
            {n.priority && <span className="small faint">priority {n.priority}</span>}
            {n.openedAt && <span className="small faint">opened {timeAgo(n.openedAt)}</span>}
          </div>
          <LockPreview n={n} />
          <dl className="push-dl small">
            <dt>To</dt>
            <dd>
              {n.user ? <Link to={`/p/${slug}/users/${n.user.id}`}>{n.user.name}</Link> : 'Unassigned'}
              {n.device && <span className="faint"> · {n.device.name}</span>}
            </dd>
            <dt>Target</dt>
            <dd>
              {n.targetKind} <code className="small">{n.target}</code>
            </dd>
            {n.collapseKey && (
              <>
                <dt>Collapse</dt>
                <dd>
                  <code>{n.collapseKey}</code>
                </dd>
              </>
            )}
            {n.tap && (
              <>
                <dt>Tap opens</dt>
                <dd>
                  {n.tap.kind} <code>{n.tap.value}</code>
                </dd>
              </>
            )}
            {n.providerMessageId && (
              <>
                <dt>Message id</dt>
                <dd>
                  <code className="small">{n.providerMessageId}</code>
                </dd>
              </>
            )}
            {n.run && (
              <>
                <dt>Run</dt>
                <dd>{n.run}</dd>
              </>
            )}
          </dl>
          {n.lint.length > 0 && (
            <div className="push-lint">
              {n.lint.map((l, i) => (
                <div key={i} className={`push-lint-item ${l.severity}`}>
                  <Badge kind={l.severity === 'error' ? 'bad' : l.severity === 'warn' ? 'warn' : ''}>{l.severity}</Badge>
                  <span className="small">{l.message}</span>
                  <code className="faint small">{l.check}</code>
                </div>
              ))}
            </div>
          )}
          {Object.keys(n.data).length > 0 && (
            <div className="table-wrap card">
              <table className="push-kv">
                <thead>
                  <tr>
                    <th>Data key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(n.data).map(([k, v]) => (
                    <tr key={k}>
                      <td>
                        <code>{k}</code>
                      </td>
                      <td className="push-kv-v">{typeof v === 'string' ? v : JSON.stringify(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {n.headers && Object.keys(n.headers).length > 0 && <CodeBlock title="Headers" code={Object.entries(n.headers).map(([k, v]) => `${k}: ${v}`).join('\n')} />}
          <CodeBlock title="Payload as sent" lang="json" code={JSON.stringify(n.raw ?? null, null, 2)} />
          {n.logId && (
            <button className="btn sm ghost" onClick={() => setLog(n.logId)}>
              <Icon name="activity" size={13} /> Request in the traffic log
            </button>
          )}
        </div>
      )}
      {log && <LogDrawer id={log} onClose={() => setLog(null)} />}
    </Drawer>
  );
}

/** Notification list with a detail drawer; used by the Push page and the user workspace. */
export function PushList({ slug, q, empty }: { slug: string; q: NotificationQuery; empty?: string }) {
  useTick(30_000);
  const r = useNotifications(slug, q);
  const [open, setOpen] = useState<string | null>(null);
  const list = r.data ?? [];
  return (
    <>
      <ErrorBox error={r.error} />
      {r.data && !list.length && (
        <Empty title="No push notifications">
          <p className="small">{empty ?? 'Pushes your backend sends through the fake FCM / APNs land here.'}</p>
        </Empty>
      )}
      {list.length > 0 && (
        <div className="push-list">
          {list.map((n) => (
            <PushRow key={n.id} n={n} active={open === n.id} onOpen={() => setOpen(n.id)} />
          ))}
        </div>
      )}
      {open && <PushDetail slug={slug} id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Block in the user workspace: the user's devices and latest pushes, unread count. */
export function UserPushBlock({ slug, userId, userName }: { slug: string; userId: string; userName: string }) {
  const devices = useFetch<PushDevice[]>(`/api/projects/${encodeURIComponent(slug)}/users/${encodeURIComponent(userId)}/push-devices`, [slug, userId]);
  const pushes = useNotifications(slug, { user: userId, limit: 5 });
  usePushReload(slug, () => void devices.reload());
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const devs = devices.data ?? [];
  const list = pushes.data ?? [];
  const unread = list.filter((n) => !n.openedAt && n.status === 'delivered').length;
  if (!devs.length && !list.length) {
    if (!devices.data) return null;
    return (
      <div className="card card-pad row push-user-empty">
        <Icon name="bell" size={15} />
        <span className="small muted grow">No push devices for {userName}.</span>
        <button
          className="btn sm"
          onClick={() =>
            void pushApi
              .addDevice(slug, { user: userId, platform: 'android' })
              .then(() => (toast('Android device added'), devices.reload()))
              .catch((e) => toast(errText(e)))
          }
        >
          Add a device
        </button>
      </div>
    );
  }
  return (
    <div className="card push-user">
      <div className="card-head row">
        <h3 className="grow">
          <Icon name="bell" size={14} /> Push
          {unread > 0 && <span className="count push-unread">{unread}</span>}
        </h3>
        <span className="small faint">
          {devs.length} device{devs.length === 1 ? '' : 's'}
        </span>
        <Link className="btn sm ghost" to={`/p/${slug}/push?user=${encodeURIComponent(userId)}`}>
          All pushes
        </Link>
      </div>
      {list.length > 0 ? (
        <div className="push-list">
          {list.map((n) => (
            <PushRow key={n.id} n={n} active={open === n.id} onOpen={() => setOpen(n.id)} />
          ))}
        </div>
      ) : (
        <p className="small muted card-pad">No pushes yet. Device tokens: {devs.map((d) => `${platformLabel[d.platform]} …${d.token.slice(-6)}`).join(', ')}</p>
      )}
      {open && <PushDetail slug={slug} id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
