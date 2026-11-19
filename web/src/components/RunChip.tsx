import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge } from './ui';

/** run id → key, per project, fetched once per project and refreshed when an unknown id shows up. */
const keys = new Map<string, Map<string, string>>();
const pending = new Map<string, Promise<void>>();

function load(slug: string): Promise<void> {
  let p = pending.get(slug);
  if (!p) {
    p = api
      .get<{ id: string; key: string }[]>(`/api/projects/${slug}/runs`)
      .then((runs) => {
        keys.set(slug, new Map(runs.map((r) => [r.id, r.key])));
      })
      .catch(() => undefined)
      .finally(() => pending.delete(slug));
    pending.set(slug, p);
  }
  return p;
}

/** "run: w3" chip for message and log rows. Pass the key directly, or a run id plus the project slug. */
export function RunChip({ runKey, runId, slug }: { runKey?: string | null; runId?: string | null; slug?: string }) {
  const known = runKey ?? (runId && slug ? keys.get(slug)?.get(runId) : undefined);
  const [, bump] = useState(0);
  useEffect(() => {
    if (known || !runId || !slug) return;
    let alive = true;
    void load(slug).then(() => alive && bump((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [known, runId, slug]);
  if (!runKey && !runId) return null;
  return (
    <Badge kind="accent" title={runId ? `Test run ${runId}` : 'Test run'}>
      run: {known ?? '…'}
    </Badge>
  );
}
