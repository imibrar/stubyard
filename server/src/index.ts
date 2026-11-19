import https from 'node:https';
import path from 'node:path';
import { pino, type Logger } from 'pino';
import { loadConfig, type Config } from './config.js';
import { openDb } from './db/index.js';
import { EventBus } from './events.js';
import { buildApp } from './http/app.js';
import type { Hub } from './hub.js';
import { Mailpit } from './mailpit/mailpit.js';
import { MessageService } from './messages/service.js';
import { MessagingSimulator } from './messages/simulator.js';
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
import { SmtpFront } from './smtp/server.js';
import { ensureTls } from './tls/ca.js';
import { TrafficLogger } from './traffic/logger.js';

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
    mailpit,
    tls,
  } as Omit<Hub, 'simulator'> as Hub;
  hub.simulator = new MessagingSimulator(hub);
  return hub;
}

export interface RunningHub {
  hub: Hub;
  close: () => Promise<void>;
  urls: { http: string; https: string | null; smtp: string };
}

/** Start every listener: HTTP, HTTPS, SMTP (and the embedded Mailpit). */
export async function startHub(config: Config, opts: HubOptions = {}): Promise<RunningHub> {
  const log = opts.logger ?? pino({ level: config.logLevel });
  const hub = createHub(config, { ...opts, logger: log });
  if (hub.mailpit) await hub.mailpit.start();

  const { app, handler } = await buildApp(hub, log);
  await app.listen({ port: config.httpPort, host: config.host });

  let httpsServer: https.Server | null = null;
  if (hub.tls) {
    httpsServer = https.createServer({ key: hub.tls.keyPem, cert: hub.tls.certPem }, handler);
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
    startTls: process.env.DEVHUB_SMTP_STARTTLS === '1',
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
    timeoutHoldMs: config.timeoutHoldMs,
    callbackDelayMs: config.callbackDelayMs,
  });
  await smtp.listen();
  // After every job handler is registered (the SMTP front registers "dsn").
  hub.scheduler.start();

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
    await hub.scheduler.stop();
    await app.close();
    await hub.mailpit?.stop();
    hub.db.close();
  };
  return { hub, close, urls };
}

async function main() {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });
  const running = await startHub(config, { logger: log });
  log.info(
    `\n  devhub is running\n  Dashboard  ${running.urls.http}\n  HTTPS      ${running.urls.https ?? '(disabled)'}\n  SMTP       ${running.urls.smtp}\n  Data       ${config.dataDir}\n`,
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
