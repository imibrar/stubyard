import { Link } from 'react-router-dom';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { InstanceConnect } from '../pages/PushPage';
import { pushApi, pushBase, type PushInstance, type PushOverview, type PushPreset } from '../pushApi';
import { Icon } from './people';
import { CopyUrl, InstanceRow, providersPath } from './providerLayout';
import { Badge, Empty, ErrorBox, useToast } from './ui';
import '../styles/push.css';

/**
 * "Push" tab of the Providers page: fake FCM projects and APNs keys of the project. The category entry is
 * PUSH_CATEGORY (appended in ProvidersPage); the inbox, devices and faults live on the Push page.
 */

const CATEGORY = 'push';
const KINDS: { id: PushPreset; name: string; description: string }[] = [
  { id: 'fcm', name: 'Firebase Cloud Messaging', description: 'FCM HTTP v1 messages:send with a service-account JSON (OAuth token_uri on stubyard), topics, conditions, Instance ID topic API.' },
  { id: 'apns', name: 'Apple Push Notification service', description: 'APNs provider API over HTTP/2 with a .p8 token key (ES256), all documented reasons, sandbox / production.' },
];

/** Tab count for the Providers page (its status() runs before the panel loads; refreshed by any fetch here). */
const counts = new Map<string, number>();
const loading = new Set<string>();
function cachedCount(slug: string): number | null {
  if (!counts.has(slug) && !loading.has(slug)) {
    loading.add(slug);
    void fetch(pushBase(slug))
      .then((r) => (r.ok ? r.json() : null))
      .then((o: PushOverview | null) => o && counts.set(slug, o.instances.length))
      .catch(() => undefined)
      .finally(() => loading.delete(slug));
  }
  return counts.get(slug) ?? null;
}

export function usePushInstances(slug: string) {
  const ov = useFetch<PushOverview>(pushBase(slug), [slug]);
  if (ov.data) counts.set(slug, ov.data.instances.length);
  const reload = useDebounced(() => void ov.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'push.changed' || e.type === 'project.reset') reload();
  });
  return { overview: ov.data, error: ov.error, reload };
}

export function PushCategory({ ctx, def, instance }: { ctx: { slug: string; add: (category: string, preset?: string) => void }; def: { description: string; emptyText: string }; instance?: string }) {
  const { slug } = ctx;
  const d = usePushInstances(slug);
  const list = d.overview?.instances ?? [];
  const found = list.find((i) => i.slug === instance);
  const selected = found ?? list[0];
  return (
    <>
      <p className="prov-intro small muted">{def.description}</p>
      <ErrorBox error={d.error} />
      {d.overview && !list.length ? (
        <Empty title="No push providers yet">
          <p className="small">{def.emptyText}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => ctx.add(CATEGORY, 'fcm')}>
              Add FCM
            </button>
            <button className="btn" onClick={() => ctx.add(CATEGORY, 'apns')}>
              Add APNs
            </button>
          </div>
        </Empty>
      ) : (
        <div className={`prov-split ${found ? 'has-selection' : ''}`}>
          <div className="card prov-list">
            <div className="card-head">
              <h3>
                {list.length} push provider{list.length === 1 ? '' : 's'}
              </h3>
              <button className="btn sm" onClick={() => ctx.add(CATEGORY)}>
                Add
              </button>
            </div>
            <div className="prov-group">
              {list.map((i) => (
                <InstanceRow
                  key={i.id}
                  to={providersPath(slug, CATEGORY, i.slug)}
                  active={selected?.id === i.id}
                  title={i.name}
                  status={!i.enabled ? <Badge kind="bad">disabled</Badge> : i.strict ? <Badge kind="warn">strict</Badge> : undefined}
                  meta={
                    <code className="faint small">
                      {i.preset} · {i.devices} device{i.devices === 1 ? '' : 's'}
                    </code>
                  }
                  url={i.urls && <CopyUrl url={String(i.preset === 'fcm' ? i.urls.tokenUri : (i.urls.apns ?? i.urls.http1))} />}
                />
              ))}
            </div>
            <p className="prov-note small faint">
              Inbox, devices and faults in <Link to={`/p/${slug}/push`}>Push</Link>.
            </p>
          </div>
          <div className="prov-detail">{selected && <PushDetailPanel key={selected.id} slug={slug} inst={selected} reload={d.reload} />}</div>
        </div>
      )}
    </>
  );
}

function PushDetailPanel({ slug, inst, reload }: { slug: string; inst: PushInstance; reload: () => void }) {
  const toast = useToast();
  const remove = async () => {
    if (!window.confirm(`Delete ${inst.name}? Its devices and pushes go too.`)) return;
    try {
      await pushApi.deleteInstance(slug, inst.slug);
      toast('Push provider deleted');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="stack">
      <div className="row">
        <Link to={providersPath(slug, CATEGORY)} className="btn sm ghost viewer-back" aria-label="Back to the list">
          ←
        </Link>
        <span className="grow" />
        <Link className="btn sm" to={`/p/${slug}/push`}>
          <Icon name="bell" size={13} /> Inbox
        </Link>
        <button className="btn sm ghost" onClick={() => void remove()}>
          Delete
        </button>
      </div>
      <InstanceConnect slug={slug} inst={inst} reload={reload} />
    </div>
  );
}

/** Add-modal fields: optional Firebase project id / bundle ids. */
export function PushAddFields({ preset, form, set }: { preset: string; form: Record<string, string | string[]>; set: (f: Record<string, string | string[]>) => void }) {
  return preset === 'apns' ? (
    <label className="stack">
      <span className="small muted">Bundle ids (comma separated, empty = any)</span>
      <input value={(form.bundleIds as string) ?? ''} placeholder="com.example.app" onChange={(e) => set({ ...form, bundleIds: e.target.value })} />
    </label>
  ) : (
    <label className="stack">
      <span className="small muted">Firebase project id (empty = generated)</span>
      <input value={(form.fcmProjectId as string) ?? ''} placeholder="my-app-12345" onChange={(e) => set({ ...form, fcmProjectId: e.target.value })} />
    </label>
  );
}

/** CategoryDef for PROVIDER_CATEGORIES (typed structurally to avoid importing the page). */
export const PUSH_CATEGORY = {
  id: CATEGORY,
  label: 'Push',
  sub: 'FCM · APNs',
  noun: 'push provider',
  description: 'Fake Firebase Cloud Messaging (HTTP v1) and Apple Push Notification service: download a service account or .p8 key that points at stubyard; every push lands in the test user’s inbox.',
  emptyText: 'Add a fake FCM project (Android, web, iOS via Firebase) or an APNs key (iOS direct).',
  icon: (size: number) => <Icon name="bell" size={size} />,
  guidePrefix: 'push',
  status: (d: { slug: string }) => ({ n: cachedCount(d.slug), problems: [] as string[] }),
  options: () => KINDS.map((k) => ({ id: k.id, name: k.name, description: k.description, available: true })),
  AddFields: PushAddFields,
  create: async (d: { slug: string }, preset: string, form: Record<string, string | string[]>) => {
    const config: Record<string, unknown> = {};
    if (preset === 'apns' && form.bundleIds) config.bundleIds = String(form.bundleIds);
    if (preset === 'fcm' && form.fcmProjectId) config.fcmProjectId = String(form.fcmProjectId);
    const i = await pushApi.createInstance(d.slug, { preset: preset as PushPreset, name: (form.name as string) || undefined, slug: (form.slug as string) || undefined, config });
    return i.slug;
  },
  Panel: PushCategory,
};
