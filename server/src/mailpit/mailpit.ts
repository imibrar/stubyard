import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';

export const MAILPIT_WEBROOT = '/mailpit/';

export interface MailpitOptions {
  bin: string;
  url: string;
  smtpHost: string;
  smtpPort: number;
  dataDir: string;
  spawn: boolean;
  log: FastifyBaseLogger;
  /**
   * Sign-in on: the spawned Mailpit gets a random web UI / API login (MP_UI_AUTH, in its environment, not its command
   * line) that only stubyard knows, so a local process cannot read mail on 127.0.0.1:8025 while /mailpit needs
   * sign-in. SMTP is not affected. Ignored for an external Mailpit (STUBYARD_MAILPIT_URL).
   */
  uiAuth?: boolean;
}

/**
 * Manages the embedded Mailpit: spawns it as a child process (restarting it if it dies),
 * relays raw messages into it over SMTP and talks to its HTTP API.
 */
export class Mailpit {
  private child: ChildProcess | null = null;
  private uiAuthPair: string | null = null;
  private stopping = false;
  private transport: Transporter;
  private authorization: string | null = null;

  constructor(private opts: MailpitOptions) {
    this.transport = nodemailer.createTransport({
      host: opts.smtpHost,
      port: opts.smtpPort,
      secure: false,
      ignoreTLS: true,
      pool: true,
      maxConnections: 4,
    });
  }

  get baseUrl(): string {
    return this.opts.url.replace(/\/$/, '') + MAILPIT_WEBROOT.replace(/\/$/, '');
  }

  /** Headers for calls to Mailpit's web UI / API (the Basic login when there is one). */
  authHeaders(): Record<string, string> {
    return this.authorization ? { authorization: this.authorization } : {};
  }

  async start(): Promise<void> {
    if (this.opts.spawn && this.opts.uiAuth && !this.authorization) {
      this.uiAuthPair = `stubyard:${randomBytes(24).toString('base64url')}`;
      this.authorization = `Basic ${Buffer.from(this.uiAuthPair).toString('base64')}`;
    }
    if (this.opts.spawn) this.spawnChild();
    await this.waitReady(20_000);
  }

  private spawnChild(): void {
    if (!fs.existsSync(this.opts.bin)) {
      throw new Error(`Mailpit binary not found at ${this.opts.bin}. Set STUBYARD_MAILPIT_BIN or STUBYARD_MAILPIT_URL.`);
    }
    const dir = path.join(this.opts.dataDir, 'mailpit');
    fs.mkdirSync(dir, { recursive: true });
    const listen = new URL(this.opts.url);
    const args = [
      '--listen', `${listen.hostname}:${listen.port || 80}`,
      '--smtp', `${this.opts.smtpHost}:${this.opts.smtpPort}`,
      '--database', path.join(dir, 'mailpit.db'),
      '--webroot', MAILPIT_WEBROOT,
      '--max', '0',
      '--quiet',
    ];
    this.opts.log.info({ args }, 'starting embedded Mailpit');
    const env = { ...process.env };
    delete env.MP_UI_AUTH;
    delete env.MP_UI_AUTH_FILE;
    if (this.uiAuthPair) env.MP_UI_AUTH = this.uiAuthPair;
    const child = spawn(this.opts.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    child.stdout?.on('data', (d) => this.opts.log.debug({ mailpit: String(d).trim() }));
    child.stderr?.on('data', (d) => this.opts.log.warn({ mailpit: String(d).trim() }));
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) return;
      this.opts.log.error({ code, signal }, 'Mailpit exited unexpectedly; restarting in 1s');
      setTimeout(() => !this.stopping && this.spawnChild(), 1000);
    });
    this.child = child;
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${this.baseUrl}/api/v1/info`, { headers: this.authHeaders() });
        if (r.ok) return;
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error(`Mailpit did not become ready at ${this.baseUrl}: ${String(lastErr)}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.transport.close();
    if (this.child) {
      const c = this.child;
      await new Promise<void>((resolve) => {
        c.once('exit', () => resolve());
        c.kill('SIGTERM');
        setTimeout(() => {
          c.kill('SIGKILL');
          resolve();
        }, 3000);
      });
    }
  }

  /** Relay a raw RFC 5322 message into Mailpit. Returns the Mailpit message ID. */
  async relay(raw: Buffer, envelope: { from: string; to: string[] }): Promise<string> {
    const info = await this.transport.sendMail({ envelope: { from: envelope.from || '', to: envelope.to }, raw });
    const match = /queued as (\S+)/i.exec(String(info.response));
    if (!match) throw new Error(`Unexpected Mailpit SMTP response: ${info.response}`);
    return match[1];
  }

  async deleteMessages(ids: string[]): Promise<void> {
    if (!ids.length) return;
    // Mailpit accepts batches; keep them reasonably small.
    for (let i = 0; i < ids.length; i += 500) {
      const r = await fetch(`${this.baseUrl}/api/v1/messages`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ IDs: ids.slice(i, i + 500) }),
      });
      if (!r.ok) throw new Error(`Mailpit delete failed: HTTP ${r.status}`);
    }
  }

  async deleteAll(): Promise<void> {
    const r = await fetch(`${this.baseUrl}/api/v1/messages`, { method: 'DELETE', headers: this.authHeaders() });
    if (!r.ok) throw new Error(`Mailpit delete-all failed: HTTP ${r.status}`);
  }
}
