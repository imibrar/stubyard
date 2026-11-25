import { randomUUID } from 'node:crypto';
import { normalizePhone } from '../../util.js';
import { SENDERS_FIELD, gccAlias, gccGate, header, type GccError } from './gcc.js';
import { INBOUND_FIELD, cfg, fields, str, type Ctx, type MockRequest, type ProviderAdapter, type Reply } from './types.js';

const ACCOUNT = '123456789012';
const NS = 'http://sns.amazonaws.com/doc/2010-03-31/';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = (status: number, body: string): Reply => ({ status, body: `<?xml version="1.0"?>\n${body}`, headers: { 'content-type': 'text/xml', 'x-amzn-requestid': randomUUID() } });

/** AWS query-protocol error: <ErrorResponse><Error><Type/><Code/><Message/></Error><RequestId/></ErrorResponse>. */
const awsError = (status: number, code: string, message: string, type: 'Sender' | 'Receiver' = status >= 500 ? 'Receiver' : 'Sender'): Reply =>
  xml(status, `<ErrorResponse xmlns="${NS}">\n  <Error>\n    <Type>${type}</Type>\n    <Code>${esc(code)}</Code>\n    <Message>${esc(message)}</Message>\n  </Error>\n  <RequestId>${randomUUID()}</RequestId>\n</ErrorResponse>`);

const ok = (action: string, result: string) =>
  xml(200, `<${action}Response xmlns="${NS}">\n  <${action}Result>${result}</${action}Result>\n  <ResponseMetadata>\n    <RequestId>${randomUUID()}</RequestId>\n  </ResponseMetadata>\n</${action}Response>`);

const NAMED: Record<GccError, Reply> = {
  auth: awsError(403, 'InvalidClientTokenId', 'The security token included in the request is invalid.'),
  sender: awsError(400, 'InvalidParameter', 'Invalid parameter: MessageAttributes Reason: the origination identity (sender ID or origination number) is not registered for this account'),
  balance: awsError(400, 'InvalidParameter', 'Invalid parameter: Reason: the account has reached its monthly SMS spend limit (MonthlySpendLimit)'),
  number: awsError(400, 'InvalidParameter', 'Invalid parameter: PhoneNumber Reason: the phone number is not valid to publish to'),
};
const named = (k: GccError, message: string | null) => {
  if (!message) return NAMED[k];
  const code = /<Code>([^<]+)<\/Code>/.exec(String(NAMED[k].body))![1]!;
  return awsError(NAMED[k].status, code, message);
};

/** Actions the simulator answers besides Publish. */
const ACCOUNT_ACTIONS = ['CheckIfPhoneNumberIsOptedOut', 'GetSMSAttributes', 'GetSMSSandboxAccountStatus'];

const actionOf = (req: MockRequest) => str(fields(req).Action) ?? header(req, 'x-amz-target')?.split('.').pop() ?? null;

/** MessageAttributes.entry.N.Name / .Value.StringValue (query protocol) as a map. */
function attributes(f: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    const m = /^MessageAttributes\.entry\.(\d+)\.Name$/.exec(k);
    if (!m) continue;
    const value = str(f[`MessageAttributes.entry.${m[1]}.Value.StringValue`]);
    if (value !== null) out[String(v)] = value;
  }
  return out;
}

/** SigV4: "AWS4-HMAC-SHA256 Credential=<key id>/<date>/<region>/sns/aws4_request, …". The signature itself is not checked. */
function credential(req: MockRequest): { keyId: string; region: string } | null {
  const m = /^AWS4-HMAC-SHA256\s+Credential=([^/,\s]+)\/\d{8}\/([^/]+)\/sns\//i.exec(header(req, 'authorization') ?? '');
  return m ? { keyId: m[1]!, region: m[2]! } : null;
}

function authError(req: MockRequest, ctx: Ctx): Reply | null {
  const c = credential(req);
  if (!c) return awsError(403, 'MissingAuthenticationToken', 'Request is missing Authentication Token');
  const want = cfg(ctx, 'accessKeyId');
  if (want && want !== c.keyId) return NAMED.auth;
  return null;
}

const regionOf = (ctx: Ctx, req?: MockRequest) => cfg(ctx, 'region') ?? (req && credential(req)?.region) ?? 'us-east-1';

/** Amazon SNS SMS: Publish with PhoneNumber (AWS query protocol: form POST to "/", XML answers, SigV4). No delivery reports over HTTP. */
export function snsAdapter(): ProviderAdapter {
  return {
    preset: 'sns',
    blockedAt: 'delivery',
    configFields: [
      { key: 'region', label: 'Region', hint: 'Shown in ARNs. Empty: the region of the request signature.', placeholder: 'us-east-1' },
      { key: 'accessKeyId', label: 'Access key ID', hint: 'Optional. When set, a request signed with another key gets 403 InvalidClientTokenId. Empty: any key works. The SigV4 signature itself is not checked.' },
      SENDERS_FIELD,
      {
        ...INBOUND_FIELD,
        hint: 'Two-way SMS: the HTTP(S) endpoint subscribed to the SNS topic that receives replies. stubyard POSTs an SNS Notification whose Message is the inbound SMS JSON.',
      },
    ],

    match(req) {
      if (req.method !== 'POST' || !/^\/?$/.test(req.path)) return null;
      const action = actionOf(req);
      if (action === 'Publish') return { kind: 'send' };
      if (action && ACCOUNT_ACTIONS.includes(action)) return { kind: 'account', what: action };
      return null;
    },

    parse(req, ctx) {
      const auth = authError(req, ctx);
      if (auth) return { error: auth };
      const f = fields(req);
      const phone = str(f.PhoneNumber);
      if (!phone) {
        if (str(f.TopicArn) || str(f.TargetArn)) return { error: awsError(400, 'InvalidParameter', 'Invalid parameter: stubyard simulates SMS publishing only (PhoneNumber); TopicArn / TargetArn are not supported') };
        return { error: awsError(400, 'InvalidParameter', 'Invalid parameter: TopicArn or TargetArn Reason: no value for required parameter') };
      }
      const to = normalizePhone(phone);
      if (!phone.trim().startsWith('+') || !to || to.length < 8) return { error: awsError(400, 'InvalidParameter', `Invalid parameter: PhoneNumber Reason: ${phone} is not valid to publish to`) };
      const message = str(f.Message);
      if (!message) return { error: awsError(400, 'ValidationError', "1 validation error detected: Value null at 'message' failed to satisfy constraint: Member must not be null") };
      const attrs = attributes(f);
      const sender = attrs['AWS.SNS.SMS.SenderID'] ?? attrs['AWS.MM.SMS.OriginationNumber'] ?? null;
      const gate = gccGate(ctx, sender);
      if (gate === 'sender') return { error: NAMED.sender };
      return {
        channel: 'sms',
        to,
        from: sender,
        body: message,
        extra: { metadata: { snsSmsType: attrs['AWS.SNS.SMS.SMSType'] ?? 'Promotional', ...(sender ? { snsSenderId: sender } : {}) } },
      };
    },

    newMessageId: () => randomUUID(),

    accepted: (_ctx, m) => ok('Publish', `\n    <MessageId>${m.id}</MessageId>\n  `),

    sendError(_ctx, kind, _parsed, code, message) {
      const n = gccAlias(code);
      if (n) return named(n, message);
      switch (kind) {
        case 'down':
          return awsError(503, code ?? 'ServiceUnavailable', message ?? 'Service is unavailable. Try again later.');
        case 'rate_limit':
          return awsError(429, code ?? 'Throttling', message ?? 'Rate exceeded');
        case 'blocked':
        case 'opt_out':
          return awsError(400, code ?? 'InvalidParameter', message ?? 'Invalid parameter: PhoneNumber Reason: the phone number has opted out of receiving SMS messages');
        default:
          return named('number', message);
      }
    },

    // Values of the SMS delivery status logs (CloudWatch), which is where SNS reports failures.
    defaultFailure: (kind) => (kind === 'blocked' ? { code: 'OPTED_OUT', message: 'Phone is currently opted out' } : { code: 'UNREACHABLE', message: 'Phone carrier has blocked this message' }),

    notFound: (req) => {
      const action = actionOf(req);
      return action
        ? awsError(400, 'InvalidAction', `The action ${action} is not valid for this web service.`)
        : awsError(404, 'UnknownOperationException', `${req.method} ${req.path} is not an SNS endpoint (POST / with Action=Publish).`);
    },

    account(ctx, what, req) {
      const auth = authError(req, ctx);
      if (auth) return auth;
      if (what === 'CheckIfPhoneNumberIsOptedOut') return ok(what, '\n    <isOptedOut>false</isOptedOut>\n  ');
      if (what === 'GetSMSSandboxAccountStatus') return ok(what, '\n    <IsInSandbox>false</IsInSandbox>\n  ');
      return ok(what, '\n    <attributes>\n      <entry><key>DefaultSMSType</key><value>Transactional</value></entry>\n      <entry><key>MonthlySpendLimit</key><value>1</value></entry>\n    </attributes>\n  ');
    },

    // SNS has no delivery-report webhook: SMS delivery status goes to CloudWatch Logs.
    statusCallback: () => null,

    inbound(ctx, m, url) {
      const region = regionOf(ctx);
      const topicArn = `arn:aws:sns:${region}:${ACCOUNT}:stubyard-${ctx.instance.slug}-inbound`;
      const id = randomUUID();
      const message = {
        originationNumber: m.from,
        destinationNumber: m.to,
        messageKeyword: (m.text.trim().split(/\s+/)[0] ?? '').toUpperCase(),
        messageBody: m.text,
        inboundMessageId: m.id,
        previousPublishedMessageId: m.context?.id ?? null,
      };
      return {
        url,
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
          'x-amz-sns-message-type': 'Notification',
          'x-amz-sns-message-id': id,
          'x-amz-sns-topic-arn': topicArn,
          'user-agent': 'Amazon Simple Notification Service Agent',
        },
        body: JSON.stringify({
          Type: 'Notification',
          MessageId: id,
          TopicArn: topicArn,
          Message: JSON.stringify(message),
          Timestamp: new Date().toISOString(),
          SignatureVersion: '1',
          Signature: 'ZGV2aHViLXVuc2lnbmVk', // stubyard does not sign SNS messages: skip signature checks in development
          SigningCertURL: `https://sns.${region}.amazonaws.com/SimpleNotificationService-stubyard.pem`,
          UnsubscribeURL: `https://sns.${region}.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${topicArn}:${randomUUID()}`,
        }),
      };
    },
  };
}
