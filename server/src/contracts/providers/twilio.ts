// Provider contract (C1 §4): the Twilio REST API as the fake Twilio serves it (providers/adapters/twilio.ts for
// Programmable Messaging, verify/twilio-verify.ts for Verify v2). Hand-written from the Twilio API reference
// (https://www.twilio.com/docs/messaging/api/message-resource, https://www.twilio.com/docs/verify/api), not a
// vendored spec: Messages create and fetch, Verify services, verifications and verification checks. One contract
// for both Twilio presets (twilio, twilio-whatsapp).
//
// Bodies are form-encoded and open (Twilio ignores parameters it does not know). Twilio answers one error at a
// time, so strict mode picks the issue Twilio would report first and answers it with Twilio's own code.

import type { JsonSchema } from '../../webhooks/schema.js';
import type { ContractIssue } from '../types.js';
import type { ProviderContract, ProviderOperation } from './index.js';

const MESSAGING = 'https://www.twilio.com/docs/messaging/api/message-resource';
const VERIFY = 'https://www.twilio.com/docs/verify/api';

const str: JsonSchema = { type: 'string' };
/** Twilio's helper libraries send "true"/"false"; form values arrive as strings. */
const bool: JsonSchema = { type: ['boolean', 'string'], enum: [true, false, 'true', 'false', 'True', 'False'] };
const uri: JsonSchema = { type: 'string', format: 'uri' };
const E164 = '\\+[1-9][0-9]{6,14}';
/** E.164, or whatsapp:+E.164 on the WhatsApp channel. */
const address: JsonSchema = { type: 'string', pattern: `^(whatsapp:)?${E164}$` };
/** A phone number, a short code or an alphanumeric sender ID (up to 11 characters, at least one letter). */
const sender: JsonSchema = { type: 'string', pattern: `^((whatsapp:)?${E164}|[0-9]{3,8}|(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11})$` };
const httpUrl: JsonSchema = { type: 'string', pattern: '^https?://\\S+$' };
const codeLength: JsonSchema = { type: 'integer', minimum: 4, maximum: 10 };

const requireOne = (...names: string[]): JsonSchema => ({ anyOf: names.map((n) => ({ required: [n] })) });

const op = (method: string, path: string, operationId: string, source: string, body?: JsonSchema): ProviderOperation => ({
  method,
  path,
  operationId,
  encoding: 'form',
  ...(body ? { body } : {}),
  source,
});

const createMessage: JsonSchema = {
  type: 'object',
  required: ['To'],
  properties: {
    To: address,
    From: sender,
    MessagingServiceSid: { type: 'string', pattern: '^MG[0-9a-fA-F]{32}$' },
    Body: { type: 'string', maxLength: 1600 },
    MediaUrl: { type: ['string', 'array'], pattern: '^https?://\\S+$', items: httpUrl, maxItems: 10 },
    ContentSid: { type: 'string', pattern: '^HX[0-9a-fA-F]{32}$' },
    ContentVariables: str,
    StatusCallback: uri,
    ApplicationSid: { type: 'string', pattern: '^AP[0-9a-fA-F]{32}$' },
    MaxPrice: { type: 'number' },
    ProvideFeedback: bool,
    Attempt: { type: 'integer', minimum: 1 },
    ValidityPeriod: { type: 'integer', minimum: 1, maximum: 36000 },
    ForceDelivery: bool,
    ContentRetention: { type: 'string', enum: ['retain', 'discard'] },
    AddressRetention: { type: 'string', enum: ['retain', 'obfuscate'] },
    SmartEncoded: bool,
    PersistentAction: { type: ['string', 'array'] },
    ShortenUrls: bool,
    ScheduleType: { type: 'string', enum: ['fixed'] },
    SendAt: { type: 'string', format: 'date-time' },
    SendAsMms: bool,
    RiskCheck: { type: 'string', enum: ['enable', 'disable'] },
  },
  // A sender (From or MessagingServiceSid) and content (Body, MediaUrl or ContentSid).
  allOf: [requireOne('From', 'MessagingServiceSid'), requireOne('Body', 'MediaUrl', 'ContentSid')],
};

const service: JsonSchema = {
  type: 'object',
  properties: { FriendlyName: { type: 'string', minLength: 1 }, CodeLength: codeLength, LookupEnabled: bool, SkipSmsToLandlines: bool, DtmfInputRequired: bool, TtsName: str, Psd2Enabled: bool, DoNotShareWarningEnabled: bool, CustomCodeEnabled: bool },
};

const VERIFY_CHANNELS = ['sms', 'call', 'email', 'whatsapp', 'sna', 'auto'];

const createVerification: JsonSchema = {
  type: 'object',
  required: ['To', 'Channel'],
  properties: {
    To: str,
    Channel: { type: 'string', enum: VERIFY_CHANNELS },
    CustomFriendlyName: str,
    CustomMessage: str,
    SendDigits: str,
    Locale: str,
    CustomCode: { type: 'string', pattern: '^[0-9A-Za-z]{4,10}$' },
    Amount: str,
    Payee: str,
    RateLimits: str,
    ChannelConfiguration: str,
    AppHash: str,
    TemplateSid: { type: 'string', pattern: '^HJ[0-9a-fA-F]{32}$' },
    TemplateCustomSubstitutions: str,
    DeviceIp: str,
    RiskCheck: { type: 'string', enum: ['enable', 'disable'] },
    Tags: str,
  },
  // To is an e-mail address on the email channel, else an E.164 number.
  allOf: [
    {
      if: { type: 'object', required: ['Channel'], properties: { Channel: { const: 'email' } } },
      then: { properties: { To: { type: 'string', format: 'email' } } },
      else: { properties: { To: { type: 'string', pattern: `^(whatsapp:)?${E164}$` } } },
    },
  ],
};

const operations: ProviderOperation[] = [
  op('POST', '/2010-04-01/Accounts/{AccountSid}/Messages.json', 'CreateMessage', MESSAGING, createMessage),
  op('POST', '/2010-04-01/Accounts/{AccountSid}/Messages', 'CreateMessage', MESSAGING, createMessage),
  op('GET', '/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json', 'FetchMessage', MESSAGING),
  op('GET', '/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}', 'FetchMessage', MESSAGING),

  op('POST', '/v2/Services', 'CreateVerifyService', VERIFY, { ...service, required: ['FriendlyName'] }),
  op('GET', '/v2/Services', 'ListVerifyService', VERIFY),
  op('GET', '/v2/Services/{ServiceSid}', 'FetchVerifyService', VERIFY),
  op('POST', '/v2/Services/{ServiceSid}', 'UpdateVerifyService', VERIFY, service),
  op('POST', '/v2/Services/{ServiceSid}/Verifications', 'CreateVerification', VERIFY, createVerification),
  op('GET', '/v2/Services/{ServiceSid}/Verifications/{Sid}', 'FetchVerification', VERIFY),
  op('POST', '/v2/Services/{ServiceSid}/Verifications/{Sid}', 'UpdateVerification', VERIFY, {
    type: 'object',
    required: ['Status'],
    properties: { Status: { type: 'string', enum: ['canceled', 'approved'] } },
  }),
  op('POST', '/v2/Services/{ServiceSid}/VerificationCheck', 'CreateVerificationCheck', VERIFY, {
    type: 'object',
    required: ['Code'],
    properties: { Code: { type: 'string', minLength: 1 }, To: str, VerificationSid: { type: 'string', pattern: '^VE[0-9a-fA-F]{32}$' }, Amount: str, Payee: str },
    allOf: [requireOne('To', 'VerificationSid')],
  }),
];

interface TwilioError {
  code: number;
  message: string;
}

/** The top-level parameter an issue is about, and whether it is missing (anyOf: the first alternative named). */
function paramOf(i: ContractIssue): { name: string | null; missing: boolean } {
  const req = /missing required property "([^"]+)"/.exec(i.message);
  if (i.pointer) {
    const name = i.pointer.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~') ?? null;
    return { name, missing: !!req && i.pointer === `/${req[1]}` };
  }
  return req ? { name: req[1], missing: true } : { name: i.name ?? null, missing: false };
}

const shown = (i: ContractIssue) => (i.actual !== undefined ? `${i.actual} ` : '');

/** Messages: Twilio's code for one issue and the order Twilio checks in (lower first). */
function messageError(i: ContractIssue): TwilioError & { rank: number } {
  // Twilio reads form parameters only: a JSON or empty body has no To.
  if (i.check === 'contract.content-type' || i.check === 'contract.body-missing') return { rank: 0, code: 21604, message: "A 'To' phone number is required." };
  const { name, missing } = paramOf(i);
  switch (name) {
    case 'To':
      return missing ? { rank: 0, code: 21604, message: "A 'To' phone number is required." } : { rank: 1, code: 21211, message: `The 'To' number ${shown(i)}is not a valid phone number.` };
    case 'MediaUrl':
      return /at most \d+ items/.test(i.message)
        ? { rank: 2, code: 21623, message: 'Number of media files exceeds allowed limit (10).' }
        : { rank: 2, code: 21620, message: `Media urls: ${shown(i)}are invalid. Please use only valid http and https urls` };
    case 'ContentSid':
      return { rank: 3, code: 21656, message: 'The ContentSid is Invalid.' };
    case 'Body':
      return missing ? { rank: 5, code: 21602, message: 'Message body is required.' } : { rank: 4, code: 21617, message: 'The concatenated message body exceeds the 1600 character limit.' };
    case 'From':
      return missing ? { rank: 6, code: 21603, message: "A 'From' phone number is required." } : { rank: 7, code: 21212, message: `The 'From' number ${shown(i)}is not a valid phone number, shortcode, or alphanumeric sender ID.` };
    case 'StatusCallback':
      return { rank: 8, code: 21609, message: `The StatusCallback URL ${shown(i)}is not a valid URL.` };
    default:
      return { rank: 9, code: 20001, message: `Invalid parameter: ${name ?? 'Body'}` };
  }
}

/** Verify: missing parameters are 20001, invalid ones 60200 (Twilio's wording). */
function verifyError(i: ContractIssue, op: ProviderOperation): TwilioError & { rank: number } {
  const firstRequired = ((op.body as { required?: string[] } | undefined)?.required ?? [])[0] ?? 'To';
  if (i.check === 'contract.content-type' || i.check === 'contract.body-missing') return { rank: 0, code: 20001, message: `Missing required parameter ${firstRequired} in the post body` };
  const { name, missing } = paramOf(i);
  if (op.operationId === 'CreateVerificationCheck' && missing && (name === 'To' || name === 'VerificationSid'))
    return { rank: 2, code: 60200, message: "Invalid parameter: Either a 'To' or a 'VerificationSid' must be specified" };
  if (missing) return { rank: 0, code: 20001, message: `Missing required parameter ${name} in the post body` };
  return { rank: 1, code: 60200, message: `Invalid parameter: ${name ?? 'Body'}` };
}

/** Twilio answers 400 {code, message, more_info, status} for the first problem it finds. */
function strictError(issues: ContractIssue[], op: ProviderOperation): { status: number; body: unknown } {
  const map = op.source === VERIFY ? (i: ContractIssue) => verifyError(i, op) : messageError;
  const errs = issues.filter((i) => i.severity === 'error').map(map);
  const e = errs.reduce((a, b) => (b.rank < a.rank ? b : a), errs[0] ?? { rank: 0, code: 20001, message: 'Invalid request' });
  return { status: 400, body: { code: e.code, message: e.message, more_info: `https://www.twilio.com/docs/errors/${e.code}`, status: 400 } };
}

export const twilioContract: ProviderContract = {
  preset: 'twilio',
  aliases: ['twilio-whatsapp'],
  title: 'Twilio REST API',
  version: '2010-04-01',
  operations,
  strictError,
};
