/**
 * Message helpers (browser-safe, fetch only).
 *
 *   import { messageCursor, waitForMessagePath, getMessage } from '@stubyard/client/messages';
 *   const cursor = await messageCursor({ project: 'hyper' }, { user: 'alice@example.test', channel: 'email' });
 *   // … the app sends the mail …
 *   const msg = await waitForMessagePath({}, resolved.waitPath);   // a waitPath made by the hub; null on timeout
 */
import { hubFetch, hubJson, projectPath, query, seg, type HubTarget } from './http.js';
import type { Channel, HubMessage } from './storyboard-types.js';

/** The current position of the message stream (optionally for one user / channel); pass it as `after=` to a wait. */
export async function messageCursor(t: HubTarget, o: { user?: string; channel?: Channel } = {}): Promise<string> {
  return (await hubJson<{ cursor: string }>(t, 'GET', projectPath(t, `/messages/cursor${query({ user: o.user, channel: o.channel })}`))).cursor;
}

/**
 * Follow a long-poll path made by the hub (a walkthrough's `waitPath`): the matching message, or null when the
 * hub's timeout passed (408). Abort with `o.signal`.
 */
export async function waitForMessagePath(t: Pick<HubTarget, 'apiUrl' | 'fetch'>, path: string, o: { signal?: AbortSignal } = {}): Promise<HubMessage | null> {
  const r = await hubFetch<HubMessage>(t, 'GET', path, undefined, { signal: o.signal, allow: [408] });
  return r.status === 408 ? null : r.body;
}

/** One message by id (email messages carry `mailpit` paths to the rendered HTML / text). */
export function getMessage(t: Pick<HubTarget, 'apiUrl' | 'fetch'>, id: string): Promise<HubMessage> {
  return hubJson<HubMessage>(t, 'GET', `/api/messages/${seg(id)}`);
}
