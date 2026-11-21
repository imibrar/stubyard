/**
 * Test-user lookups (browser-safe, fetch only).
 *
 *   import { getUser, latestMessage } from '@stubyard/client/users';
 *   const admin = await getUser({ project: 'hyper' }, 'admin');                  // id, email, phone, name or role
 *   const last = await latestMessage({ project: 'hyper' }, admin.id, { otp: true });  // null when there is none yet
 */
import { hubFetch, hubJson, projectPath, query, seg, StubyardError, type HubTarget } from './http.js';
import type { Channel, HubMessage, HubUser } from './storyboard-types.js';

/** The project's test users (with their effective password). */
export function listUsers(t: HubTarget): Promise<HubUser[]> {
  return hubJson<HubUser[]>(t, 'GET', projectPath(t, '/users'));
}

/** One user by id, email, phone, name or role, with inbox counts and the latest message. */
export function getUser(t: HubTarget, ref: string): Promise<HubUser & { inbox: unknown; latest: unknown }> {
  return hubJson(t, 'GET', projectPath(t, `/users/${seg(ref)}`));
}

/** The user's newest message (optionally on one channel / only with an OTP); null when there is none (404). */
export async function latestMessage(
  t: HubTarget,
  ref: string,
  o: { channel?: Channel; otp?: boolean } = {},
): Promise<{ message: HubMessage; otp: string | null; link: string | null; links: string[] } | null> {
  const r = await hubFetch<{ message: HubMessage; otp: string | null; link: string | null; links: string[] } | { error: string }>(
    t,
    'GET',
    projectPath(t, `/users/${seg(ref)}/latest${query({ channel: o.channel, otp: o.otp })}`),
    undefined,
    { allow: [404] },
  );
  if (r.status === 404) {
    // 404 also means "unknown user": tell the two apart by the message.
    const err = (r.body as { error?: string } | undefined)?.error ?? '';
    if (/^No (code|message) for /.test(err)) return null;
    throw new StubyardError(404, `stubyard answered 404 for GET user ${ref}: ${err}`, undefined, r.body);
  }
  return r.body as { message: HubMessage; otp: string | null; link: string | null; links: string[] };
}
