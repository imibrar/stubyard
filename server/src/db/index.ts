import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrations } from './migrations.js';

type Param = null | number | bigint | string | Uint8Array;

/** Thin wrapper over Node's built-in SQLite (no native dependency to compile). */
export class DB {
  readonly raw: DatabaseSync;
  private depth = 0;
  private cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return new Statement(s);
  }

  /** Returns a function that runs `fn` inside a transaction (nested calls use savepoints). */
  transaction<T>(fn: () => T): () => T {
    return () => {
      const sp = `sp_${this.depth}`;
      const outer = this.depth === 0;
      this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const result = fn();
        this.depth--;
        this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        this.depth--;
        this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw err;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

export class Statement {
  constructor(private s: StatementSync) {}

  run(...params: unknown[]): { changes: number } {
    const r = this.s.run(...(params.map(bind) as Param[]));
    return { changes: Number(r.changes) };
  }

  get(...params: unknown[]): unknown {
    const r = this.s.get(...(params.map(bind) as Param[]));
    return r === undefined ? undefined : { ...r };
  }

  all(...params: unknown[]): unknown[] {
    return this.s.all(...(params.map(bind) as Param[])).map((r) => ({ ...r }));
  }
}

function bind(v: unknown): Param {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DB(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
    })();
  }
}
