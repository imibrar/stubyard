// The fake Nafath prompt (B5, docs/plans/b5-nafath.md §5.3): while one of the walkthrough's actors has a WAITING
// Nafath request, the widget (above the step card) and the side panel's Walkthrough screen show it like the Nafath app:
// the three numbers (the right one approves, another rejects as wrong_number) and Reject. It goes away once the request
// leaves WAITING (decided here, in stubyard, by a rule or by expiry). Polls every 2 s, only while a walkthrough is
// active and the view is visible.
import { useEffect, useState } from 'react';
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { chooseNafathNumber, listNafathRequests, rejectNafathRequest, type NafathRequest } from '@stubyard/client/nafath';
import { StubyardError } from '@stubyard/client/http';
import { ErrorBox, useAction } from '../sidepanel/context';
import type { HubTarget } from '../sidepanel/hub';
import { useStepHost } from './host';

export const NAFATH_POLL_MS = 2000;

export interface ActorNafath {
  /** The actor's key in the walkthrough. */
  actor: string;
  name: string;
  request: NafathRequest;
}

/** The test users of the walkthrough's actors (deleted ones left out). */
export function actorUsers(w: WalkthroughView): string[] {
  return Object.values(w.actors ?? {})
    .filter((a) => !a.missing && a.userId)
    .map((a) => a.userId)
    .sort();
}

/** The WAITING requests of the walkthrough's actors, oldest first. */
export function actorRequests(w: WalkthroughView, list: readonly NafathRequest[]): ActorNafath[] {
  const byUser = new Map(Object.entries(w.actors ?? {}).filter(([, a]) => !a.missing).map(([key, a]) => [a.userId, { key, name: a.name }]));
  return list
    .filter((r) => r.status === 'WAITING' && r.testUserId && byUser.has(r.testUserId))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((r) => {
      const a = byUser.get(r.testUserId!)!;
      return { actor: a.key, name: a.name, request: r };
    });
}

/**
 * Polls the project's WAITING Nafath requests (every 2 s while the walkthrough is active, the page is visible and it
 * has actors) and keeps those of its actors. A hub without fake Nafath (404) stops the polling.
 */
export function useNafathWaiting(t: HubTarget | null, w: WalkthroughView | null) {
  const users = w && w.status === 'active' ? actorUsers(w).join(',') : '';
  const [list, setList] = useState<NafathRequest[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setList([]);
    if (!t || !users) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const all = await listNafathRequests(t, { status: 'WAITING', limit: 50 });
          if (live) setList(all);
        } catch (err) {
          if (err instanceof StubyardError && err.status === 404) live = false;
          // Otherwise (hub offline, a failed load): keep the last list; the next poll tries again.
        }
      }
      if (live) timer = setTimeout(() => void poll(), NAFATH_POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [t?.apiUrl, t?.project, users, tick]);
  return {
    items: w ? actorRequests(w, list) : [],
    /** Drop a decided request at once and poll again. */
    settle: (id: string) => {
      setList((l) => l.filter((r) => r.id !== id));
      setTick((n) => n + 1);
    },
  };
}

export function NafathPrompt({ t, w }: { t: HubTarget; w: WalkthroughView }) {
  const { items, settle } = useNafathWaiting(t, w);
  if (!items.length) return null;
  return (
    <>
      {items.map((x) => (
        <NafathRequestCard key={x.request.id} t={t} item={x} multi={Object.keys(w.actors).length > 1} settle={settle} />
      ))}
    </>
  );
}

function NafathRequestCard({ t, item, multi, settle }: { t: HubTarget; item: ActorNafath; multi: boolean; settle: (id: string) => void }) {
  const p = useStepHost();
  const act = useAction();
  const r = item.request;
  const headId = `nafath-${r.id}`;
  const who = multi ? `${item.name} (${item.actor})` : item.name;

  const decide = (label: string, fn: () => Promise<NafathRequest>) =>
    act.run(label, async () => {
      try {
        const out = await fn();
        p.notify(
          out.status === 'COMPLETED'
            ? `Nafath: approved for ${item.name}`
            : out.reason === 'wrong_number'
              ? `Nafath: wrong number, the request for ${item.name} is rejected`
              : `Nafath: rejected for ${item.name}`,
        );
      } finally {
        settle(r.id);
      }
    });

  return (
    <section className="nafath" aria-labelledby={headId}>
      <p className="nafath-head" id={headId} role="status">
        <span className="nafath-brand">Nafath</span> request for <strong dir="auto">{who}</strong>
      </p>
      {r.service && (
        <p className="muted small" dir="auto">
          Service: {r.service}
        </p>
      )}
      <p className="small">Pick the number the app shows to approve.</p>
      <div className="nafath-nums" role="group" aria-label="Numbers">
        {r.choices.map((n) => (
          <button key={n} className="nafath-num" disabled={!!act.busy} aria-label={`Choose ${n}`} onClick={() => void decide(`choose-${n}`, () => chooseNafathNumber(t, r.id, n))}>
            {n}
          </button>
        ))}
      </div>
      <div className="row">
        <button className="danger" disabled={!!act.busy} onClick={() => void decide('reject', () => rejectNafathRequest(t, r.id))}>
          {act.busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      <ErrorBox error={act.error} />
    </section>
  );
}
