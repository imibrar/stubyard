import { HttpError } from '../util.js';

/**
 * Push faults: a rule (push_rules) or one request (X-Hub-Scenario) makes FCM / APNs answer the way the real service
 * does when something is wrong. Each fault maps to the provider's own error shape.
 */
export const PUSH_FAULTS = ['unregistered', 'bad_token', 'quota', 'unavailable', 'internal', 'auth', 'sender_mismatch', 'payload_too_large', 'topic_disallowed', 'timeout', 'drop', 'slow'] as const;
export type PushFaultKind = (typeof PUSH_FAULTS)[number];

export interface PushFault {
  kind: PushFaultKind;
  /** quota: retry-after seconds; slow: delay ms. */
  arg: number | null;
  spec: string;
}

export const FAULT_HELP: { fault: string; fcm: string; apns: string }[] = [
  { fault: 'unregistered', fcm: '404 UNREGISTERED (NOT_FOUND)', apns: '410 Unregistered + timestamp' },
  { fault: 'bad_token', fcm: '400 INVALID_ARGUMENT "not a valid FCM registration token"', apns: '400 BadDeviceToken' },
  { fault: 'quota[:secs]', fcm: '429 QUOTA_EXCEEDED (RESOURCE_EXHAUSTED) + Retry-After', apns: '429 TooManyRequests' },
  { fault: 'unavailable', fcm: '503 UNAVAILABLE', apns: '503 ServiceUnavailable' },
  { fault: 'internal', fcm: '500 INTERNAL', apns: '500 InternalServerError' },
  { fault: 'auth', fcm: '401 THIRD_PARTY_AUTH_ERROR', apns: '403 InvalidProviderToken' },
  { fault: 'sender_mismatch', fcm: '403 SENDER_ID_MISMATCH (PERMISSION_DENIED)', apns: '400 DeviceTokenNotForTopic' },
  { fault: 'payload_too_large', fcm: '400 INVALID_ARGUMENT "Message is too big"', apns: '413 PayloadTooLarge' },
  { fault: 'topic_disallowed', fcm: '400 INVALID_ARGUMENT "Invalid topic"', apns: '400 TopicDisallowed' },
  { fault: 'timeout', fcm: 'hold the request (STUBYARD_TIMEOUT_HOLD_MS), then close the connection', apns: 'same (stream reset)' },
  { fault: 'drop', fcm: '200 as usual, the notification is stored as dropped (never reaches the device)', apns: 'same' },
  { fault: 'slow:<ms>', fcm: 'answer normally after <ms> milliseconds', apns: 'same' },
];

export function parseFault(input: unknown): PushFault {
  const spec = String(input ?? '').trim().toLowerCase();
  const [kind, rawArg] = spec.split(':');
  if (!(PUSH_FAULTS as readonly string[]).includes(kind)) throw new HttpError(400, `Unknown push fault "${spec}". Use one of: ${FAULT_HELP.map((f) => f.fault).join(', ')}`);
  let arg: number | null = null;
  if (rawArg !== undefined && rawArg !== '') {
    arg = Number(rawArg);
    if (!Number.isFinite(arg) || arg < 0) throw new HttpError(400, `Fault "${spec}": the number after ":" must be ≥ 0`);
  }
  if (kind === 'slow' && arg === null) throw new HttpError(400, 'Fault "slow" needs a delay: slow:<ms>');
  if (arg !== null && kind !== 'slow' && kind !== 'quota') throw new HttpError(400, `Fault "${kind}" takes no argument`);
  return { kind: kind as PushFaultKind, arg, spec: arg !== null ? `${kind}:${arg}` : kind };
}

/** Fault → FCM error code (null: not an error answer). */
export function fcmErrorFor(f: PushFault): { code: string; message: string; retryAfter?: number } | null {
  switch (f.kind) {
    case 'unregistered':
      return { code: 'UNREGISTERED', message: 'Requested entity was not found.' };
    case 'bad_token':
      return { code: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' };
    case 'quota':
      return { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for quota metric \'Send requests\'.', retryAfter: f.arg ?? 60 };
    case 'unavailable':
      return { code: 'UNAVAILABLE', message: 'The service is currently unavailable.' };
    case 'internal':
      return { code: 'INTERNAL', message: 'Internal error encountered.' };
    case 'auth':
      return { code: 'THIRD_PARTY_AUTH_ERROR', message: 'Auth error from APNS or Web Push Service' };
    case 'sender_mismatch':
      return { code: 'SENDER_ID_MISMATCH', message: 'SenderId mismatch' };
    case 'payload_too_large':
      return { code: 'INVALID_ARGUMENT', message: 'Message is too big' };
    case 'topic_disallowed':
      return { code: 'INVALID_ARGUMENT', message: 'Invalid topic' };
    default:
      return null;
  }
}

/** Fault → APNs reason (null: not an error answer). */
export function apnsReasonFor(f: PushFault): string | null {
  const map: Partial<Record<PushFaultKind, string>> = {
    unregistered: 'Unregistered',
    bad_token: 'BadDeviceToken',
    quota: 'TooManyRequests',
    unavailable: 'ServiceUnavailable',
    internal: 'InternalServerError',
    auth: 'InvalidProviderToken',
    sender_mismatch: 'DeviceTokenNotForTopic',
    payload_too_large: 'PayloadTooLarge',
    topic_disallowed: 'TopicDisallowed',
  };
  return map[f.kind] ?? null;
}
