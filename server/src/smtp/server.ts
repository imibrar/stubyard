import { simpleParser, type AddressObject } from 'mailparser';
import { SMTPServer, type SMTPServerAddress, type SMTPServerSession } from 'smtp-server';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import type { Mailpit } from '../mailpit/mailpit.js';
import type { MessageService } from '../messages/service.js';
import { htmlToText } from '../messages/extract.js';
import type { Project, ProjectRepo } from '../repos/projects.js';
import type { ProviderInstance, ProviderRepo } from '../repos/providers.js';
import type { UserRepo } from '../repos/users.js';
import type { TrafficLogger } from '../traffic/logger.js';
import type { Scheduler, Job } from '../jobs/scheduler.js';
import type { MessageRepo } from '../repos/messages.js';
import type { EventBus } from '../events.js';
import type { Decision, RuleEngine } from '../rules/engine.js';
import { normalizeEmail, nowIso } from '../util.js';
import type { Run } from '../repos/runs.js';
import type { TestUser } from '../repos/users.js';
import { plusTag, type Attribution, type RunResolver } from '../runs/resolver.js';
import { mimeHasTextPart } from '../lint/checks.js';

export interface SmtpFrontOptions {
  port: number;
  host: string;
  maxEmailBytes: number;
  tls?: { key: string; cert: string };
  /** Advertise STARTTLS (off by default: many clients then require a trusted certificate). */
  startTls: boolean;
  projects: ProjectRepo;
  providers: ProviderRepo;
  users: UserRepo;
  messages: MessageService;
  traffic: TrafficLogger;
  mailpit: Mailpit;
  log: FastifyBaseLogger;
  engine: RuleEngine;
  scheduler: Scheduler;
  messageRepo: MessageRepo;
  bus: EventBus;
  /** Test-run attribution (optional: without it nothing is attributed to a run). */
  runs?: RunResolver;
  /** How long a "timeout" rule holds the SMTP reply. */
  timeoutHoldMs: number;
  /** Default time until a "fail" turns into a bounce email. */
  callbackDelayMs: number;
}

interface DsnJob {
  messageId: string;
  envelopeFrom: string;
  recipient: string;
  status: string;
  diagnostic: string;
}

interface TranscriptLine {
  at: string;
  command: string;
  response: string;
}

interface SessionState {
  transcript: TranscriptLine[];
  project: Project | null;
  instance: ProviderInstance | null;
  /** How the project was determined: "auth" (username) or "recipient". */
  resolvedBy: 'auth' | 'recipient' | null;
  username: string | null;
  /** Run named by the SMTP username ("hyper+w3"). */
  run: Run | null;
  logId: string | null;
  /**
   * Rule decision per accepted recipient (normalized address) of the current transaction. `commit` updates the
   * rule's counters; it runs when DATA is accepted, so an abandoned transaction does not use up "fail next 1".
   */
  decisions: Map<string, { decision: Decision; commit: () => void; user: TestUser | null; attribution: Attribution }>;
}

class SmtpError extends Error {
  constructor(
    public responseCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * SMTP front door. Every step (auth, MAIL FROM, RCPT TO, DATA) is logged. Messages are
 * tagged with their project and relayed into Mailpit, then indexed into the per-user inbox.
 *
 * Project resolution:
 *  - SMTP username "project" or "project.instance" (password ignored), or
 *  - without auth: the project that has a test user with the recipient address,
 *    or the only project when exactly one exists.
 */
export class SmtpFront {
  private server: SMTPServer;
  private sessions = new Map<string, SessionState>();

  constructor(private o: SmtpFrontOptions) {
    this.server = new SMTPServer({
      secure: false,
      key: o.tls?.key,
      cert: o.tls?.cert,
      hideSTARTTLS: !o.startTls || !o.tls,
      authOptional: true,
      allowInsecureAuth: true,
      authMethods: ['PLAIN', 'LOGIN'],
      size: o.maxEmailBytes,
      banner: 'stubyard SMTP (development only, nothing is delivered)',
      logger: false,
      onConnect: (session, cb) => {
        this.sessions.set(session.id, {
          transcript: [{ at: nowIso(), command: `CONNECT ${session.remoteAddress}`, response: '220' }],
          project: null,
          instance: null,
          resolvedBy: null,
          username: null,
          run: null,
          logId: null,
          decisions: new Map(),
        });
        cb();
      },
      onAuth: (auth, session, cb) => {
        const st = this.state(session);
        const username = String(auth.username ?? '').trim();
        st.username = username;
        try {
          const { project, instance, run } = this.resolveUsername(username);
          st.project = project;
          st.instance = instance;
          st.run = run;
          st.resolvedBy = 'auth';
          this.note(st, `AUTH ${auth.method} ${username}`, '235 Authentication successful');
          cb(null, { user: username });
        } catch (err) {
          const e = err as SmtpError;
          this.note(st, `AUTH ${auth.method} ${username}`, `${e.responseCode} ${e.message}`);
          // Auth failures happen outside any mail transaction; log them on their own.
          const id = this.o.traffic.start({
            direction: 'inbound',
            protocol: 'smtp',
            method: 'AUTH',
            url: `smtp://${username || '(none)'}@stubyard:${this.o.port}`,
            clientIp: session.remoteAddress,
            resolved: { username },
          });
          this.o.traffic.finish(id, {
            resStatus: e.responseCode,
            resBody: e.message,
            outcome: 'rejected',
            errorType: 'auth_failed',
            errorMessage: e.message,
            transcript: [...st.transcript],
          });
          cb(e);
        }
      },
      onMailFrom: (address, session, cb) => {
        const st = this.state(session);
        if (st.logId) {
          // Previous transaction was abandoned (RSET or new MAIL FROM without DATA).
          this.o.traffic.finish(st.logId, {
            projectId: st.project?.id ?? null,
            outcome: 'rejected',
            errorType: 'no_message',
            errorMessage: lastRejection(st) ?? 'Transaction abandoned before a message was sent',
            resStatus: lastRejectionCode(st),
            transcript: [...st.transcript],
          });
        }
        // A new transaction: uncommitted rule decisions of an abandoned one are dropped (rules not used up).
        st.decisions.clear();
        // Start its log entry right away.
        st.logId = this.o.traffic.start({
          projectId: st.project?.id ?? null,
          direction: 'inbound',
          protocol: 'smtp',
          method: 'SMTP',
          url: this.smtpUrl(st),
          clientIp: session.remoteAddress,
          resolved: this.resolvedInfo(st),
          runId: st.run?.id ?? null,
        });
        this.note(st, `MAIL FROM:<${address.address}>`, '250 Accepted');
        cb();
      },
      onRcptTo: (address, session, cb) => {
        const st = this.state(session);
        try {
          this.resolveForRecipient(st, address);
          if (st.instance && !st.instance.enabled) {
            throw new SmtpError(550, `Provider instance "${st.instance.slug}" is disabled in stubyard`);
          }
          if (st.logId) {
            this.o.traffic.update(st.logId, { projectId: st.project?.id ?? null });
            this.o.traffic.mergeResolved(st.logId, this.resolvedInfo(st));
          }
          const rcpt = normalizeEmail(address.address) ?? address.address;
          const explicit = st.run ? { run: st.run, via: 'smtp-username' as const } : null;
          const attributed: { user: TestUser | null } & Attribution = this.o.runs
            ? this.o.runs.forRecipient(st.project!.id, 'email', rcpt, explicit)
            : { user: st.project ? this.o.users.findByEmail(st.project.id, rcpt) : null, run: null, via: null };
          const { user } = attributed;
          const attribution: Attribution = { run: attributed.run, via: attributed.via };
          if (attribution.run && st.logId) {
            this.o.traffic.update(st.logId, { runId: attribution.run.id });
            this.o.traffic.mergeResolved(st.logId, { run: attribution.run.key, runVia: attribution.via });
          }
          const { decision, commit } = this.o.engine.peek({ projectId: st.project!.id, channel: 'email', instance: st.instance, user, runId: attribution.run?.id ?? null });
          if (decision.rule && st.logId) this.o.traffic.mergeResolved(st.logId, { [`rule:${rcpt}`]: decision.rule.label });
          const refusal = smtpRefusal(decision, rcpt);
          if (decision.action === 'timeout') {
            this.note(st, `RCPT TO:<${address.address}>`, '(no answer: timeout rule)');
            // Refusals use up the rule when they are actually returned.
            setTimeout(() => {
              commit();
              cb(new SmtpError(421, '4.4.2 Timeout (stubyard rule)'));
            }, this.o.timeoutHoldMs).unref?.();
            return;
          }
          if (refusal) {
            commit();
            throw refusal;
          }
          st.decisions.set(rcpt, { decision, commit, user, attribution });
          const accept = () => {
            this.note(st, `RCPT TO:<${address.address}>`, `250 Accepted${decision.rule ? ` (rule: ${decision.rule.label})` : ''}`);
            cb();
          };
          if (decision.action === 'slow') setTimeout(accept, decision.delayMs ?? 3000);
          else accept();
        } catch (err) {
          const e = err as SmtpError;
          this.note(st, `RCPT TO:<${address.address}>`, `${e.responseCode} ${e.message}`);
          cb(e);
        }
      },
      onData: (stream, session, cb) => {
        this.handleData(stream, session).then(
          (msg) => cb(null, msg),
          (err: SmtpError) => cb(err),
        );
      },
      onClose: (session) => {
        const st = this.sessions.get(session.id);
        this.sessions.delete(session.id);
        if (st?.logId) {
          // Transaction started (MAIL FROM) but no message was accepted.
          this.note(st, 'QUIT', '221 Bye');
          this.o.traffic.finish(st.logId, {
            projectId: st.project?.id ?? null,
            outcome: 'rejected',
            errorType: 'no_message',
            errorMessage: lastRejection(st) ?? 'Connection closed before a message was sent',
            resStatus: lastRejectionCode(st),
            transcript: st.transcript,
          });
        }
      },
    });
    this.server.on('error', (err) => o.log.error({ err }, 'SMTP server error'));
    o.scheduler.register('dsn', (job) => this.sendDsn(job as unknown as Job<DsnJob>));
  }

  /** A delayed bounce: mark the message bounced and send a standard DSN email to the sender. */
  private async sendDsn(job: Job<DsnJob>): Promise<void> {
    const p = job.payload;
    const original = this.o.messageRepo.get(p.messageId);
    if (!original) return;
    const project = this.o.projects.get(original.projectId);
    if (!project) return;
    const updated = this.o.messageRepo.updateStatus(original.id, { status: 'bounced', statusDetail: `Bounced later: ${p.diagnostic}` });
    if (updated) this.o.bus.publish({ type: 'message.updated', projectId: project.id, data: updated });

    const boundary = `stubyard-dsn-${original.id}`;
    const subject = 'Undelivered Mail Returned to Sender';
    const text = [
      'This is the mail system at host stubyard.local.',
      '',
      "I'm sorry to have to inform you that your message could not",
      'be delivered to one or more recipients.',
      '',
      `<${p.recipient}>: ${p.diagnostic}`,
      '',
      `Original subject: ${original.subject ?? ''}`,
    ].join('\r\n');
    const raw = [
      'From: Mail Delivery System <MAILER-DAEMON@stubyard.local>',
      `To: <${p.envelopeFrom}>`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <dsn-${original.id}@stubyard.local>`,
      'Auto-Submitted: auto-replied',
      'MIME-Version: 1.0',
      `X-Tags: project-${project.slug}, dsn`,
      `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; stubyard.local',
      `Arrival-Date: ${new Date(original.createdAt).toUTCString()}`,
      '',
      `Final-Recipient: rfc822; ${p.recipient}`,
      `Original-Recipient: rfc822; ${p.recipient}`,
      'Action: failed',
      `Status: ${p.status}`,
      `Diagnostic-Code: smtp; ${p.diagnostic}`,
      '',
      `--${boundary}`,
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: ${original.messageIdHeader ?? ''}`,
      `From: ${original.from ?? ''}`,
      `To: ${p.recipient}`,
      `Subject: ${original.subject ?? ''}`,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const mailpitId = await this.o.mailpit.relay(Buffer.from(raw), { from: '', to: [p.envelopeFrom] });
    this.o.messages.capture({
      project,
      instance: original.providerInstanceId ? this.o.providers.getById(original.providerInstanceId) : null,
      channel: 'email',
      from: 'MAILER-DAEMON@stubyard.local',
      to: p.envelopeFrom,
      subject,
      text,
      mailpitId,
      messageIdHeader: `<dsn-${original.id}@stubyard.local>`,
      status: 'delivered',
      statusDetail: `Bounce report for the email to ${p.recipient}`,
      logId: null,
      duplicateWindowSeconds: 0,
      runId: original.runId,
      metadata: { dsn: true, bounceOf: original.id, recipient: p.recipient },
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.o.port, this.o.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private state(session: SMTPServerSession): SessionState {
    let st = this.sessions.get(session.id);
    if (!st) {
      st = { transcript: [], project: null, instance: null, resolvedBy: null, username: null, run: null, logId: null, decisions: new Map() };
      this.sessions.set(session.id, st);
    }
    return st;
  }

  private note(st: SessionState, command: string, response: string): void {
    st.transcript.push({ at: nowIso(), command, response });
  }

  private smtpUrl(st: SessionState): string {
    return `smtp://${st.username || '(no auth)'}@stubyard:${this.o.port}`;
  }

  private resolvedInfo(st: SessionState): Record<string, unknown> {
    const a = st.run ? { run: st.run, via: 'smtp-username' } : [...st.decisions.values()].find((d) => d.attribution.run)?.attribution;
    const runInfo = a?.run ? { run: a.run.key, runVia: a.via } : {};
    return {
      channel: 'email',
      project: st.project?.slug ?? null,
      instance: st.instance?.slug ?? null,
      resolvedBy: st.resolvedBy,
      username: st.username,
      ...runInfo,
    };
  }

  private resolveUsername(username: string): { project: Project; instance: ProviderInstance | null; run: Run | null } {
    if (!username) throw new SmtpError(535, 'Username required: use the project slug, e.g. "hyper" or "hyper.marketing"');
    // "hyper+w3" / "hyper.marketing+w3": the part after "+" names a test run.
    const plus = username.indexOf('+');
    const runKey = plus >= 0 ? username.slice(plus + 1).trim() : null;
    const [projectSlug, instanceSlug] = (plus >= 0 ? username.slice(0, plus) : username).split('.', 2);
    const project = this.o.projects.getBySlug(projectSlug.toLowerCase());
    if (!project) throw new SmtpError(535, `Unknown project "${projectSlug}". Use a project slug from the stubyard dashboard as the SMTP username`);
    let instance: ProviderInstance | null;
    if (instanceSlug) {
      instance = this.o.providers.get(project.id, instanceSlug.toLowerCase());
      if (!instance || instance.channel !== 'email') {
        throw new SmtpError(535, `Project "${project.slug}" has no email provider instance "${instanceSlug}"`);
      }
    } else {
      instance = this.o.providers.defaultFor(project.id, 'email');
    }
    let run: Run | null = null;
    if (runKey !== null) {
      run = this.o.runs?.explicit(project.id, runKey) ?? null;
      if (!run) throw new SmtpError(535, `Project "${project.slug}" has no active test run "${runKey}" (unknown, stopped or expired)`);
    }
    return { project, instance, run };
  }

  private resolveForRecipient(st: SessionState, address: SMTPServerAddress): void {
    if (st.project) return;
    const email = normalizeEmail(address.address) ?? '';
    let candidates = this.o.users.projectIdsByEmail(email);
    // "admin+w3@hyper.test": a plus-tagged address of a test user.
    const tag = candidates.length ? null : plusTag(email);
    if (tag) candidates = this.o.users.projectIdsByEmail(tag.base);
    let project: Project | null = null;
    if (candidates.length === 1) project = this.o.projects.get(candidates[0]);
    if (!project) {
      const all = this.o.projects.list();
      if (all.length === 1) project = all[0];
    }
    if (!project) {
      throw new SmtpError(
        550,
        'stubyard cannot tell which project this email belongs to. Authenticate with the project slug as SMTP username (e.g. "hyper")',
      );
    }
    st.project = project;
    st.instance = this.o.providers.defaultFor(project.id, 'email');
    st.resolvedBy = 'recipient';
  }

  private async handleData(stream: Readable, session: SMTPServerSession): Promise<string> {
    const st = this.state(session);
    const logId = st.logId;
    st.logId = null; // transaction is being completed here, not in onClose
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const original = Buffer.concat(chunks);
    const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
    const rcpts = session.envelope.rcptTo.map((r) => r.address);

    const finishLog = (patch: Parameters<TrafficLogger['finish']>[1]) => {
      if (!logId) return;
      const clipped = this.o.traffic.clip(original);
      this.o.traffic.finish(logId, {
        projectId: st.project?.id ?? null,
        reqBody: clipped.text,
        reqBodySize: clipped.size,
        reqTruncated: clipped.truncated,
        transcript: st.transcript,
        ...patch,
      });
    };

    if ((stream as Readable & { sizeExceeded?: boolean }).sizeExceeded) {
      const msg = `Message exceeds the maximum size of ${this.o.maxEmailBytes} bytes`;
      this.note(st, 'DATA', `552 ${msg}`);
      finishLog({ resStatus: 552, resBody: msg, outcome: 'rejected', errorType: 'too_large', errorMessage: msg });
      throw new SmtpError(552, msg);
    }

    try {
      const parsed = await simpleParser(original);
      const project = st.project!;
      const extraHeaders = [
        `X-Tags: project-${project.slug}${st.instance ? `, instance-${st.instance.slug}` : ''}`,
        `X-Stubyard-Log-Id: ${logId ?? ''}`,
      ];
      let messageId = parsed.messageId ?? null;
      if (!messageId) {
        messageId = `<${logId ?? Date.now()}@stubyard>`;
        extraHeaders.push(`Message-ID: ${messageId}`);
      }
      const raw = Buffer.concat([Buffer.from(extraHeaders.join('\r\n') + '\r\n'), original]);
      const mailpitId = await this.o.mailpit.relay(raw, { from: envelopeFrom, to: rcpts });

      const html = typeof parsed.html === 'string' ? parsed.html : null;
      const text = parsed.text?.trim() || (html ? htmlToText(html) : '');
      const fromText = parsed.from?.value?.[0]?.address ?? envelopeFrom ?? null;
      const headerTo = flattenAddresses(parsed.to);
      const lintInput = {
        headers: headersToObject(parsed.headerLines),
        hasTextPart: mimeHasTextPart(original),
        fromName: parsed.from?.value?.[0]?.name || null,
        subject: parsed.subject ?? '',
      };
      const created = rcpts.map((rcpt) => {
        const entry = st.decisions.get(normalizeEmail(rcpt) ?? rcpt);
        const decision = entry?.decision;
        const attribution = entry ? { testUserId: entry.user?.id ?? null, runId: entry.attribution.run?.id ?? null } : {};
        const outcome = emailOutcome(decision);
        const m = this.o.messages.capture({
          project,
          instance: st.instance,
          channel: 'email',
          from: fromText,
          to: rcpt,
          subject: parsed.subject ?? '(no subject)',
          text,
          html,
          attachments: parsed.attachments?.length ?? 0,
          mailpitId,
          messageIdHeader: messageId,
          status: outcome.status,
          statusDetail: outcome.detail,
          appliedRule: decision?.rule ? { ...decision.rule, level: decision.level } : undefined,
          duplicateWindowSeconds: project.settings.duplicateWindowSeconds,
          logId,
          ...attribution,
          lintInput,
          metadata: {
            envelopeFrom,
            headerTo,
            cc: flattenAddresses(parsed.cc),
            bcc: !headerTo.includes(normalizeEmail(rcpt) ?? '') && !flattenAddresses(parsed.cc).includes(normalizeEmail(rcpt) ?? ''),
          },
        });
        if (outcome.dsnAfterMs !== null && envelopeFrom) {
          this.o.scheduler.schedule(
            'dsn',
            { messageId: m.id, envelopeFrom, recipient: rcpt, status: outcome.dsnStatus, diagnostic: outcome.diagnostic } satisfies DsnJob as unknown as Record<string, unknown>,
            { projectId: project.id, delayMs: outcome.dsnAfterMs ?? this.o.callbackDelayMs },
          );
        }
        if (outcome.status === 'scheduled') {
          this.o.scheduler.schedule('status', { messageId: m.id, status: 'delivered', setStatus: 'delivered' }, { projectId: project.id, delayMs: decision?.delayMs ?? 0 });
        }
        return m;
      });
      // The email is accepted: now the rules that decided its fate count as used.
      for (const { commit } of st.decisions.values()) commit();
      const info = this.resolvedInfo(st);
      st.decisions.clear();
      const response = `Ok: queued as ${mailpitId}`;
      this.note(st, `DATA (${original.length} bytes)`, `250 ${response}`);
      finishLog({
        reqHeaders: headersToObject(parsed.headerLines),
        resStatus: 250,
        resBody: response,
        outcome: 'ok',
        resolved: {
          ...info,
          mailpitId,
          messageIds: created.map((m) => m.id),
          testUserIds: created.map((m) => m.testUserId),
        },
      });
      return response;
    } catch (err) {
      const msg = `stubyard could not store the message: ${(err as Error).message}`;
      this.o.log.error({ err }, 'SMTP DATA handling failed');
      this.note(st, 'DATA', `451 ${msg}`);
      finishLog({ resStatus: 451, resBody: msg, outcome: 'internal_error', errorType: 'store_failed', errorMessage: msg });
      throw new SmtpError(451, msg);
    }
  }
}

function flattenAddresses(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((o) => o.value.map((v) => normalizeEmail(v.address) ?? '')).filter(Boolean);
}

function headersToObject(lines: readonly { key: string; line: string }[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const { key, line } of lines) {
    const value = line.slice(line.indexOf(':') + 1).trim();
    const cur = out[key];
    if (cur === undefined) out[key] = value;
    else out[key] = Array.isArray(cur) ? [...cur, value] : [cur, value];
  }
  return out;
}

function lastRejection(st: SessionState): string | null {
  for (let i = st.transcript.length - 1; i >= 0; i--) {
    const r = st.transcript[i].response;
    if (/^[45]\d\d /.test(r)) return `${st.transcript[i].command} → ${r}`;
  }
  return null;
}

function lastRejectionCode(st: SessionState): number | null {
  for (let i = st.transcript.length - 1; i >= 0; i--) {
    const m = /^([45]\d\d) /.exec(st.transcript[i].response);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Rules that refuse the recipient during the SMTP conversation. */
function smtpRefusal(d: Decision, rcpt: string): SmtpError | null {
  const msg = (fallback: string) => (d.errorMessage ? `${d.errorCode ? d.errorCode + ' ' : ''}${d.errorMessage}` : fallback);
  if (d.level === 'opt_out') return new SmtpError(550, msg(`5.7.1 <${rcpt}>: Recipient unsubscribed from marketing email`));
  switch (d.action) {
    case 'reject':
    case 'bounce_hard':
      return new SmtpError(550, msg(`5.1.1 <${rcpt}>: Recipient address rejected: User unknown in virtual mailbox table`));
    case 'blocked':
      return new SmtpError(550, msg(`5.7.1 <${rcpt}>: Message rejected: recipient blocked`));
    case 'bounce_soft':
      return new SmtpError(452, msg(`4.2.2 <${rcpt}>: Mailbox full`));
    case 'defer':
      return new SmtpError(450, msg(`4.7.1 <${rcpt}>: Recipient address rejected: try again later (greylisted)`));
    case 'rate_limit':
      return new SmtpError(451, msg('4.7.1 Rate limit exceeded, slow down'));
    case 'down':
      return new SmtpError(421, msg('4.3.2 Service not available, closing transmission channel'));
    default:
      return null;
  }
}

/** What happens to an accepted email, per the rule. */
function emailOutcome(d: Decision | undefined): {
  status: string;
  detail: string | null;
  dsnAfterMs: number | null;
  dsnStatus: string;
  diagnostic: string;
} {
  const base = { dsnAfterMs: null, dsnStatus: '5.1.1', diagnostic: '550 5.1.1 Recipient address rejected: User unknown' };
  if (!d) return { status: 'delivered', detail: null, ...base };
  const diag = d.errorMessage ? `${d.errorCode ?? '550'} ${d.errorMessage}` : base.diagnostic;
  switch (d.action) {
    case 'fail':
      // Accepted by the server, then it bounces: the sender gets a DSN shortly after.
      return { status: 'failed', detail: `Delivery failed: ${diag}`, ...base, dsnAfterMs: d.delayMs ?? 0, diagnostic: diag };
    case 'bounce_delayed':
      return { status: 'delivered', detail: `Will bounce in ${((d.delayMs ?? 10_000) / 1000).toFixed(0)}s`, ...base, dsnAfterMs: d.delayMs ?? 10_000, diagnostic: diag };
    case 'drop':
      return { status: 'dropped', detail: 'Accepted, then silently dropped', ...base };
    case 'delay':
      return { status: 'scheduled', detail: `Arrives in ${((d.delayMs ?? 0) / 1000).toFixed(1)}s`, ...base };
    case 'complaint':
      return { status: 'complained', detail: 'Delivered, then the recipient marked it as spam', ...base };
    default:
      return { status: 'delivered', detail: null, ...base };
  }
}
