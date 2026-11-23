import https from 'node:https';
import path from 'node:path';
import { pino, type Logger } from 'pino';
import { envVar, loadConfig, type Config } from './config.js';
import { openDb } from './db/index.js';
import { EventBus } from './events.js';
import { buildApp } from './http/app.js';
import type { Hub } from './hub.js';
import { Mailpit } from './mailpit/mailpit.js';
import { MessageService } from './messages/service.js';
import { MessagingSimulator } from './messages/simulator.js';
import { installEmailApi } from './messages/email-api.js';
import { Scheduler } from './jobs/scheduler.js';
import { RuleRepo } from './repos/rules.js';
import { RuleEngine } from './rules/engine.js';
import type { FastifyBaseLogger } from 'fastify';
import { AuthenticatorRepo } from './repos/authenticators.js';
import { LogRepo } from './repos/logs.js';
import { MessageRepo } from './repos/messages.js';
import { ProjectRepo } from './repos/projects.js';
import { ProviderRepo } from './repos/providers.js';
import { UserRepo } from './repos/users.js';
import { MockRepo } from './repos/mocks.js';
import { createApiMockHandler } from './mocks/handler.js';
import { Maintenance } from './maintenance/retention.js';
import { SmtpFront } from './smtp/server.js';
import { ensureTls } from './tls/ca.js';
import { TrafficLogger } from './traffic/logger.js';
import { configureOutbound } from './traffic/outbound.js';
import { seedProjects, type SeedResult } from './maintenance/seed.js';
import { WebhookRepo } from './repos/webhooks.js';
import { WebhookService } from './webhooks/service.js';
import { RunService } from './runs/service.js';
import { AuthService } from './auth/service.js';
import { MediaRepo, VerifyRepo } from './repos/verify.js';
import { registerAuthExport } from './auth/export.js';
import { StorageService, installCheckContinue } from './storage/service.js';
import { registerS3Protocol } from './storage/s3/index.js';
import { registerCloudinaryProtocol } from './storage/cloudinary/index.js';
import { registerGcsProtocol } from './storage/gcs/index.js';
import { registerAzureProtocol } from './storage/azure/index.js';
import { registerSupabaseProtocol } from './storage/supabase/index.js';
import { registerStorageExport } from './storage/export.js';
import { McpTesterService } from './mcptester/service.js';
import { Clock } from './clock/clock.js';
import { ScheduleService } from './schedules/service.js';
import { registerMcpTesterExport } from './mcptester/export.js';
import { ChatService } from './chat/service.js';
import { registerChatExport } from './chat/export.js';
import { PaymentService } from './payments/service.js';
import { registerPaymentExport } from './payments/export.js';
import { LlmMockService } from './llmmocks/service.js';
import { registerLlmExport } from './llmmocks/export.js';
import { AutoReplyService } from './autoreplies/service.js';
import { registerAutoReplyExport } from './autoreplies/export.js';
import { PersonaService } from './personas/service.js';
import { registerPersonaExport } from './personas/export.js';
import { StoryboardServiceImpl } from './storyboards/service.js';
import { registerStoryboardExport } from './storyboards/export.js';
import { WalkthroughServiceImpl } from './storyboards/walkthroughs.js';
import { RecordingService } from './storyboards/recordings.js';
import { FeatureService } from './features/service.js';
import { registerFeatureExport } from './features/export.js';
import { PushService } from './push/service.js';
import { registerPushExport } from './push/export.js';
import { startApnsServer, type ApnsListener } from './push/apns-server.js';
import { AccessService, authWarnings } from './access/service.js';
import { SqliteAuthStore } from './access/store.js';

export interface HubOptions {
  /** Skip Mailpit entirely (tests). A custom Mailpit-like object can be injected instead. */
  mailpit?: Mailpit | null;
  tls?: boolean;
  logger?: Logger;
  dbFile?: string;
}

/** Wire repositories and services. Does not open any network port. */
export function createHub(config: Config, opts: HubOptions = {}): Hub {
  const log = opts.logger ?? pino({ level: config.logLevel });
  configureOutbound({ allow: config.outboundAllow, insecureTls: config.outboundInsecureTls });
  const db = openDb(opts.dbFile ?? path.join(config.dataDir, 'hub.db'));
  const bus = new EventBus();
  const logs = new LogRepo(db);
  const users = new UserRepo(db);
  const messages = new MessageRepo(db);
  const tls = opts.tls === false ? null : ensureTls(path.join(config.dataDir, 'certs'), config.tlsExtraNames);
  const mailpit =
    opts.mailpit !== undefined
      ? opts.mailpit
      : new Mailpit({
          bin: config.mailpitBin,
          url: config.mailpitUrl,
          smtpHost: config.mailpitSmtpHost,
          smtpPort: config.mailpitSmtpPort,
          dataDir: config.dataDir,
          spawn: config.spawnMailpit,
          uiAuth: !!config.admin,
          log,
        });
  const rules = new RuleRepo(db);
  const hub = {
    config,
    db,
    bus,
    rules,
    engine: new RuleEngine(rules),
    scheduler: new Scheduler(db, log as unknown as FastifyBaseLogger),
    projects: new ProjectRepo(db),
    users,
    providers: new ProviderRepo(db),
    authenticators: new AuthenticatorRepo(db),
    messages,
    logs,
    traffic: new TrafficLogger(logs, bus, config.maxLogBodyBytes),
    messageService: new MessageService(messages, users, bus),
    verify: new VerifyRepo(db),
    media: new MediaRepo(db),
    mailpit,
    tls,
    access: new AccessService(config, new SqliteAuthStore(db)),
  } as Omit<Hub, 'simulator'> as Hub;
  hub.clock = new Clock(hub);
  hub.simulator = new MessagingSimulator(hub);
  installEmailApi(hub);
  hub.mocks = new MockRepo(db);
  hub.maintenance = new Maintenance(hub);
  hub.simulator.extensions.apiMocks = createApiMockHandler(hub);
  hub.webhooks = new WebhookRepo(db);
  hub.webhookService = new WebhookService(hub);
  hub.runs = new RunService(hub);
  hub.schedules = new ScheduleService(hub);
  hub.payments = new PaymentService(hub);
  registerPaymentExport();
  hub.auth = new AuthService(hub);
  registerAuthExport();
  registerS3Protocol();
  registerCloudinaryProtocol();
  registerGcsProtocol();
  registerAzureProtocol();
  registerSupabaseProtocol();
  hub.storage = new StorageService(hub);
  registerStorageExport();
  hub.mcpTester = new McpTesterService(hub);
  registerMcpTesterExport();
  hub.chat = new ChatService(hub);
  registerChatExport();
  hub.llm = new LlmMockService(hub);
  registerLlmExport();
  hub.autoReplies = new AutoReplyService(hub);
  registerAutoReplyExport();
  hub.personas = new PersonaService(hub);
  registerPersonaExport();
  hub.push = new PushService(hub);
  registerPushExport();
  hub.storyboards = new StoryboardServiceImpl(hub);
  registerStoryboardExport();
  hub.recordings = new RecordingService(hub);
  hub.walkthroughs = new WalkthroughServiceImpl(hub);
  hub.features = new FeatureService(hub);
  registerFeatureExport();
  hub.messageService.runs = hub.runs.resolver;
  return hub;
}

export interface RunningHub {
  hub: Hub;
  close: () => Promise<void>;
  urls: { http: string; https: string | null; smtp: string };
  /** Result of STUBYARD_SEED (null when no seed is configured). */
  seed: SeedResult[] | null;
}

/** Start every listener: HTTP, HTTPS, SMTP (and the embedded Mailpit). */
export async function startHub(config: Config, opts: HubOptions = {}): Promise<RunningHub> {
  const log = opts.logger ?? pino({ level: config.logLevel });
  const hub = createHub(config, { ...opts, logger: log });
  if (hub.mailpit) await hub.mailpit.start();
  const seed = config.seedPath ? seedProjects(hub, config.seedPath, log) : null;

  const { app, handler } = await buildApp(hub, log);
  await app.listen({ port: config.httpPort, host: config.host });

  let httpsServer: https.Server | null = null;
  if (hub.tls) {
    httpsServer = https.createServer({ key: hub.tls.keyPem, cert: hub.tls.certPem }, handler);
    installCheckContinue(httpsServer, handler, config.storageDomain);
    await new Promise<void>((resolve, reject) => {
      httpsServer!.once('error', reject);
      httpsServer!.listen(config.httpsPort, config.host, () => resolve());
    });
  }

  if (!hub.mailpit) throw new Error('SMTP front requires Mailpit');
  const smtp = new SmtpFront({
    port: config.smtpPort,
    host: config.host,
    maxEmailBytes: config.maxEmailBytes,
    tls: hub.tls ? { key: hub.tls.keyPem, cert: hub.tls.certPem } : undefined,
    startTls: envVar('STUBYARD_SMTP_STARTTLS') === '1',
    projects: hub.projects,
    providers: hub.providers,
    users: hub.users,
    messages: hub.messageService,
    traffic: hub.traffic,
    mailpit: hub.mailpit,
    log,
    engine: hub.engine,
    scheduler: hub.scheduler,
    messageRepo: hub.messages,
    bus: hub.bus,
    runs: hub.runs.resolver,
    timeoutHoldMs: config.timeoutHoldMs,
    callbackDelayMs: config.callbackDelayMs,
  });
  await smtp.listen();
  // Fake APNs: its own HTTP/2 listener (STUBYARD_APNS_PORT, 0 = off).
  const apns: ApnsListener | null = config.apnsPort
    ? await startApnsServer(hub, { port: config.apnsPort, host: config.host, log }).catch((err: Error) => (log.warn({ err: err.message }, `APNs listener not started on port ${config.apnsPort}`), null))
    : null;
  // After every job handler is registered (the SMTP front registers "dsn").
  hub.scheduler.start();
  hub.maintenance.start();

  const urls = {
    http: `http://localhost:${config.httpPort}`,
    https: hub.tls ? `https://localhost:${config.httpsPort}` : null,
    smtp: `smtp://localhost:${config.smtpPort}`,
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await smtp.close().catch(() => undefined);
    if (httpsServer) {
      httpsServer.closeAllConnections();
      await new Promise<void>((r) => httpsServer!.close(() => r()));
    }
    await apns?.close().catch(() => undefined);
    await hub.mcpTester.closeAll();
    await hub.scheduler.stop();
    await hub.maintenance.stop();
    await app.close();
    await hub.mailpit?.stop();
    hub.db.close();
  };
  return { hub, close, urls, seed };
}

async function main() {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });
  const running = await startHub(config, { logger: log });
  // Never log the password or its hash.
  if (config.admin) log.info(`Sign-in is on (single admin: ${config.admin.email}); sessions last ${config.sessionTtlHours} h, cookie ${config.cookieSecure ? 'Secure' : 'not Secure (set STUBYARD_COOKIE_SECURE=1 behind HTTPS)'}`);
  for (const w of authWarnings(config)) log.warn(w);
  log.info(
    `\n  stubyard is running\n  Dashboard  ${running.urls.http}\n  HTTPS      ${running.urls.https ?? '(disabled)'}\n  SMTP       ${running.urls.smtp}\n  Data       ${config.dataDir}\n  Listening  ${config.host}${config.host === '127.0.0.1' ? ' (this machine only; STUBYARD_HOST=0.0.0.0 to expose)' : ''}\n  Agent guide ${running.urls.http}/api/agent-guide\n`,
  );
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
