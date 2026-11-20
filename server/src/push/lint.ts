import type { PushLintFinding } from './types.js';

/** Push integration checks, stored on each notification row (own list; lint/** is the message content checks). */
export const PUSH_LINT_CHECKS = [
  { id: 'push.payload-near-limit', severity: 'warn', title: 'Payload near the size limit', description: 'The payload is larger than 3500 bytes; FCM and APNs refuse more than 4096 bytes (2048 for FCM topic messages, 5120 for VoIP).' },
  { id: 'push.apns-missing-push-type', severity: 'warn', title: 'No apns-push-type', description: 'APNs requires apns-push-type on watchOS 6+ and recommends it everywhere; without it delivery may be delayed or dropped.' },
  { id: 'push.apns-background-priority', severity: 'warn', title: 'Background push with the wrong priority', description: 'A background (content-available) push must use apns-priority 5 and push type background. Priority 10 is an error.' },
  { id: 'push.apns-topic-mismatch', severity: 'warn', title: 'Topic suffix does not fit the push type', description: 'VoIP, complication, file provider, Live Activity, push-to-talk and widgets pushes need the bundle id plus the matching suffix (.voip, .complication, .pushkit.fileprovider, .push-type.liveactivity…).' },
  { id: 'push.apns-token-churn', severity: 'info', title: 'Provider token refreshed too often', description: 'A new APNs provider token more often than once every 20 minutes on one connection; real APNs answers 429 TooManyProviderTokenUpdates. Cache the token for 20–60 minutes.' },
  { id: 'push.fcm-legacy-api', severity: 'error', title: 'Legacy FCM API', description: 'The legacy HTTP (/fcm/send) and batch (/batch) APIs were shut down by Google: use HTTP v1 messages:send.' },
  { id: 'push.fcm-sender-mismatch', severity: 'error', title: 'Wrong Firebase project', description: 'The project id in the URL is not the one of the service account; real FCM answers 403 SENDER_ID_MISMATCH.' },
  { id: 'push.no-title-or-data', severity: 'warn', title: 'Nothing to show or handle', description: 'No title, body or data: the device gets an empty notification.' },
  { id: 'push.unknown-token', severity: 'info', title: 'Unknown device token', description: 'The token was not registered in stubyard; a device was created for it (Unassigned). Register test devices with a user to see pushes in their inbox.' },
  { id: 'push.production-env-in-test', severity: 'warn', title: 'Production APNs environment', description: 'The APNs instance is set to production: check that the test setup does not point at api.push.apple.com.' },
] as const;

export type PushCheckId = (typeof PUSH_LINT_CHECKS)[number]['id'];

export function pushFinding(check: PushCheckId, message?: string): PushLintFinding {
  const c = PUSH_LINT_CHECKS.find((x) => x.id === check)!;
  return { check, severity: c.severity, message: message ?? c.title };
}
