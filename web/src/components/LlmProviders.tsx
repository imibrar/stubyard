import { Link } from 'react-router-dom';
import type { AiProvider } from '../chatApi';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { llmApi, llmBase, type LlmConnect, type LlmOverview, type LlmProvider } from '../llmApi';
import { Icon } from './people';
import { CopyUrl, InstanceRow, providersPath } from './providerLayout';
import { Badge, CodeBlock, ErrorBox, useToast } from './ui';
import '../styles/llm.css';

/**
 * "LLM APIs" tab of the Providers page: the fake OpenAI and Anthropic APIs every project has under
 * /llm/<project>/<provider>/. Nothing to create: the list shows both, the detail has the env, a recording
 * toggle and a link to the LLM mocks page. The category entry is LLM_CATEGORY (appended in ProvidersPage).
 */

const CATEGORY = 'llm';
const KINDS: { id: LlmProvider; name: string; description: string }[] = [
  { id: 'openai', name: 'OpenAI API', description: 'Chat Completions, Responses, embeddings and models (also for OpenAI-compatible SDKs).' },
  { id: 'anthropic', name: 'Anthropic API', description: 'Messages with streaming and tool use, count_tokens and models.' },
];

export function useLlmData(slug: string) {
  const ov = useFetch<LlmOverview>(llmBase(slug), [slug]);
  const connect = useFetch<LlmConnect>(`${llmBase(slug)}/connect`, [slug]);
  const reload = useDebounced(() => (void ov.reload(), void connect.reload()), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'llm.changed' || e.type === 'project.reset') reload();
  });
  return { overview: ov.data, connect: connect.data, error: ov.error ?? connect.error, reload };
}

interface PanelCtx {
  slug: string;
}

export function LlmCategory({ ctx, def, instance }: { ctx: PanelCtx; def: { description: string }; instance?: string }) {
  const { slug } = ctx;
  const d = useLlmData(slug);
  const found = KINDS.find((k) => k.id === instance);
  const selected = found ?? KINDS[0];
  const recs = d.overview?.recordings ?? [];
  return (
    <>
      <p className="prov-intro small muted">{def.description}</p>
      <ErrorBox error={d.error} />
      <div className={`prov-split ${found ? 'has-selection' : ''}`}>
        <div className="card prov-list">
          <div className="card-head">
            <h3>2 fake LLM APIs</h3>
          </div>
          <div className="prov-group">
            {KINDS.map((k) => {
              const rec = recs.find((r) => r.kind === k.id);
              return (
                <InstanceRow
                  key={k.id}
                  to={providersPath(slug, CATEGORY, k.id)}
                  active={selected.id === k.id}
                  title={k.name}
                  status={rec ? <Badge kind="bad">● recording</Badge> : undefined}
                  meta={<code className="faint small">{k.id}</code>}
                  url={d.connect && <CopyUrl url={d.connect[k.id].baseUrl} />}
                />
              );
            })}
          </div>
          <p className="prov-note small faint">
            Always on for every project. Script replies, faults and recordings in <Link to={`/p/${slug}/llm`}>LLM mocks</Link>.
          </p>
        </div>
        <div className="prov-detail">
          <LlmDetail key={selected.id} slug={slug} kind={selected} d={d} />
        </div>
      </div>
    </>
  );
}

function LlmDetail({ slug, kind, d }: { slug: string; kind: (typeof KINDS)[number]; d: ReturnType<typeof useLlmData> }) {
  const toast = useToast();
  const providers = useFetch<{ providers: AiProvider[] }>('/api/system/ai-providers');
  const rec = (d.overview?.recordings ?? []).find((r) => r.kind === kind.id);
  const usable = (providers.data?.providers ?? []).filter((p) => p.enabled && (kind.id === 'anthropic' ? p.kind === 'anthropic' : p.kind === 'openai' || p.kind === 'openai-compatible'));
  const c = d.connect?.[kind.id];
  const toggle = async () => {
    try {
      if (rec) await llmApi.stopRecording(slug, rec.id);
      else await llmApi.startRecording(slug, { provider: usable[0].id });
      toast(rec ? 'Recording stopped' : `Recording via ${usable[0].name}`);
      d.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <div className="row">
          <Link to={providersPath(slug, CATEGORY)} className="btn sm ghost viewer-back" aria-label="Back to the list">
            ←
          </Link>
          <h2 className="grow llm-detail-title">{kind.name}</h2>
          <Link className="btn sm" to={`/p/${slug}/llm`}>
            <Icon name="code" size={13} /> Script replies
          </Link>
        </div>
        <p className="small muted">{kind.description}</p>
        {c && <CopyUrl url={c.baseUrl} label="Base URL copied" />}
        <div className="row small">
          <span className="muted">
            {d.overview ? `${d.overview.mocks} mock${d.overview.mocks === 1 ? '' : 's'} · ${d.overview.faults} fault rule${d.overview.faults === 1 ? '' : 's'} · ${d.overview.calls} recent call${d.overview.calls === 1 ? '' : 's'}` : '…'}
          </span>
          <Link to={`/p/${slug}/llm?tab=calls`}>Calls</Link>
        </div>
      </div>
      {c && <CodeBlock title=".env" code={Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join('\n')} />}
      <div className="card card-pad stack">
        <div className="row">
          <h3 className="grow">Record real answers</h3>
          {rec && <Badge kind="bad">● recording</Badge>}
        </div>
        <p className="small muted">
          {rec
            ? `Unmatched calls go to ${rec.providerRef} and are saved as mocks (${rec.calls} so far).`
            : usable.length
              ? `Forward calls no mock answers to ${usable[0].name} once and save the answers as mocks.`
              : 'Add an ' + (kind.id === 'anthropic' ? 'Anthropic' : 'OpenAI or OpenAI-compatible') + ' provider under System → AI providers to record real answers.'}
        </p>
        <div className="row">
          {(rec || usable.length > 0) && (
            <button className={`btn ${rec ? '' : 'primary'}`} onClick={() => void toggle()}>
              {rec ? 'Stop recording' : 'Start recording'}
            </button>
          )}
          <Link to={`/p/${slug}/llm?tab=recording`} className="small">
            More options
          </Link>
        </div>
      </div>
    </div>
  );
}

/** No add-modal fields: both APIs always exist. */
export function LlmAddFields() {
  return <p className="small muted">Nothing to set up: the fake OpenAI and Anthropic APIs exist for every project. Pick one to see its base URL.</p>;
}

/** CategoryDef for PROVIDER_CATEGORIES (typed structurally to avoid importing the page). */
export const LLM_CATEGORY = {
  id: CATEGORY,
  label: 'LLM APIs',
  sub: 'OpenAI · Anthropic',
  noun: 'LLM API',
  description: 'Fake OpenAI and Anthropic APIs: point the SDK base URL here and script replies, tool calls and faults, or record real answers once and replay them offline.',
  emptyText: 'The fake OpenAI and Anthropic APIs are always available.',
  icon: (size: number) => <Icon name="code" size={size} />,
  guidePrefix: 'llm',
  status: () => ({ n: KINDS.length, problems: [] as string[] }),
  options: () => KINDS.map((k) => ({ id: k.id, name: k.name, description: k.description, available: true })),
  AddFields: LlmAddFields,
  create: async (_d: unknown, preset: string) => preset,
  Panel: LlmCategory,
};
