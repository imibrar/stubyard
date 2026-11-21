import type { DB } from '../db/index.js';
import { HttpError, newId, normalizeEmail, normalizePhone, nowIso } from '../util.js';

export interface TestUser {
  id: string;
  projectId: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  marketingOptOut: boolean;
  notes: string;
  /** 0 = not pinned; otherwise position in the pinned bar. */
  pinned: number;
  password: string | null;
  /** Ephemeral user of a test run (null = a normal project user). */
  runId: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  project_id: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  marketing_opt_out: number;
  notes: string;
  pinned: number;
  password: string | null;
  run_id?: string | null;
  created_at: string;
}

function toUser(r: UserRow): TestUser {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    role: r.role,
    email: r.email,
    phone: r.phone,
    whatsapp: r.whatsapp,
    marketingOptOut: r.marketing_opt_out === 1,
    notes: r.notes,
    pinned: r.pinned ?? 0,
    password: r.password ?? null,
    runId: r.run_id ?? null,
    createdAt: r.created_at,
  };
}

export interface UserInput {
  name?: string;
  role?: string;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  marketingOptOut?: boolean;
  notes?: string;
  password?: string | null;
  pinned?: boolean;
  /** Owner run (ephemeral user). */
  runId?: string | null;
}

export interface RoleCount {
  role: string;
  count: number;
}

/** First names for generated users (also storyboards' {{fake.firstName}}). */
export const FIRST_NAMES = [
  'Ali', 'Sara', 'Omar', 'Ayesha', 'Hamza', 'Fatima', 'Bilal', 'Zainab', 'Usman', 'Hira',
  'John', 'Emma', 'Liam', 'Olivia', 'Noah', 'Mia', 'Lucas', 'Sofia', 'Adam', 'Lina',
];

export class UserRepo {
  constructor(private db: DB) {}

  /**
   * Project users (no run). With `runId`: that run's users first, then the project users.
   * `all: true`: every user, including those of all runs.
   */
  list(projectId: string, opts: { runId?: string | null; all?: boolean } = {}): TestUser[] {
    const order = "ORDER BY CASE WHEN pinned > 0 THEN pinned ELSE 1000000 END, CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at";
    const rows = opts.all
      ? this.db.prepare(`SELECT * FROM test_users WHERE project_id = ? ${order}`).all(projectId)
      : opts.runId
        ? this.db.prepare(`SELECT * FROM test_users WHERE project_id = ? AND (run_id IS NULL OR run_id = ?) ORDER BY CASE WHEN run_id IS NULL THEN 1 ELSE 0 END, ${order.slice(9)}`).all(projectId, opts.runId)
        : this.db.prepare(`SELECT * FROM test_users WHERE project_id = ? AND run_id IS NULL ${order}`).all(projectId);
    return (rows as UserRow[]).map(toUser);
  }

  /** Users minted for one run. */
  listForRun(runId: string): TestUser[] {
    return (this.db.prepare('SELECT * FROM test_users WHERE run_id = ? ORDER BY created_at, id').all(runId) as UserRow[]).map(toUser);
  }

  get(projectId: string, id: string): TestUser | null {
    const r = this.db.prepare('SELECT * FROM test_users WHERE project_id = ? AND id = ?').get(projectId, id) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  require(projectId: string, id: string): TestUser {
    const u = this.get(projectId, id);
    if (!u) throw new HttpError(404, `Test user "${id}" not found`);
    return u;
  }

  findByEmail(projectId: string, email: string): TestUser | null {
    const r = this.db
      .prepare('SELECT * FROM test_users WHERE project_id = ? AND email = ?')
      .get(projectId, normalizeEmail(email)) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  /** Projects that have a test user with this email (used when SMTP clients don't authenticate). */
  projectIdsByEmail(email: string): string[] {
    return (this.db.prepare('SELECT DISTINCT project_id FROM test_users WHERE email = ?').all(normalizeEmail(email)) as {
      project_id: string;
    }[]).map((r) => r.project_id);
  }

  findByPhone(projectId: string, phone: string, channel: 'sms' | 'whatsapp'): TestUser | null {
    const col = channel === 'sms' ? 'phone' : 'whatsapp';
    const r = this.db
      .prepare(`SELECT * FROM test_users WHERE project_id = ? AND ${col} = ?`)
      .get(projectId, normalizePhone(phone)) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  create(projectId: string, input: UserInput): TestUser {
    const name = (input.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Test user name is required');
    const id = newId();
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    const whatsapp = input.whatsapp === undefined ? phone : normalizePhone(input.whatsapp);
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, `Invalid email address "${email}"`);
    this.checkUnique(projectId, { email, phone, whatsapp });
    this.db
      .prepare(
        `INSERT INTO test_users (id, project_id, name, role, email, phone, whatsapp, marketing_opt_out, notes, password, pinned, run_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, projectId, name, normalizeRole(input.role), email, phone, whatsapp, input.marketingOptOut ? 1 : 0, input.notes ?? '',
        input.password || null, input.pinned && !input.runId ? this.nextPin(projectId) : 0, input.runId ?? null, nowIso(),
      );
    return this.get(projectId, id)!;
  }

  update(projectId: string, id: string, patch: UserInput): TestUser {
    const u = this.require(projectId, id);
    const next = {
      name: patch.name !== undefined ? patch.name.trim() : u.name,
      role: patch.role !== undefined ? normalizeRole(patch.role) : u.role,
      email: patch.email !== undefined ? normalizeEmail(patch.email) : u.email,
      phone: patch.phone !== undefined ? normalizePhone(patch.phone) : u.phone,
      whatsapp: patch.whatsapp !== undefined ? normalizePhone(patch.whatsapp) : u.whatsapp,
      marketingOptOut: patch.marketingOptOut ?? u.marketingOptOut,
      notes: patch.notes ?? u.notes,
      password: patch.password !== undefined ? patch.password || null : u.password,
    };
    if (!next.name) throw new HttpError(400, 'Test user name cannot be empty');
    this.checkUnique(projectId, next, id);
    this.db
      .prepare('UPDATE test_users SET name=?, role=?, email=?, phone=?, whatsapp=?, marketing_opt_out=?, notes=?, password=? WHERE id=?')
      .run(next.name, next.role, next.email, next.phone, next.whatsapp, next.marketingOptOut ? 1 : 0, next.notes, next.password, id);
    if (patch.pinned !== undefined && patch.pinned !== u.pinned > 0) this.setPinned(projectId, id, patch.pinned);
    return this.get(projectId, id)!;
  }

  /** Pin (append to the end of the pinned bar) or unpin a user; positions stay contiguous. */
  setPinned(projectId: string, id: string, pinned: boolean): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE test_users SET pinned = ? WHERE project_id = ? AND id = ?').run(pinned ? this.nextPin(projectId) : 0, projectId, id);
      this.compactPins(projectId);
    })();
  }

  /** Set the pinned bar to exactly these users, in this order. */
  reorderPins(projectId: string, ids: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE test_users SET pinned = 0 WHERE project_id = ?').run(projectId);
      const stmt = this.db.prepare('UPDATE test_users SET pinned = ? WHERE project_id = ? AND id = ?');
      ids.forEach((id, i) => stmt.run(i + 1, projectId, id));
    })();
  }

  private nextPin(projectId: string): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(pinned), 0) AS m FROM test_users WHERE project_id = ?').get(projectId) as { m: number };
    return r.m + 1;
  }

  private compactPins(projectId: string): void {
    const rows = this.db.prepare('SELECT id FROM test_users WHERE project_id = ? AND pinned > 0 ORDER BY pinned').all(projectId) as { id: string }[];
    const stmt = this.db.prepare('UPDATE test_users SET pinned = ? WHERE id = ?');
    rows.forEach((r, i) => stmt.run(i + 1, r.id));
  }

  /**
   * Find a user by id, email, phone/WhatsApp number, name or role (first user with that role).
   * Lets agents say `user=admin` or `user=admin@hyper.test` instead of looking up ids.
   */
  resolve(projectId: string, ref: string, runId?: string | null): TestUser | null {
    const r = ref.trim();
    if (!r) return null;
    // Ids, emails and numbers are unique in a project: they resolve any user, including run users.
    const byId = this.get(projectId, r);
    if (byId) return byId;
    if (r.includes('@')) return this.findByEmail(projectId, r);
    if (/^[+\d][\d\s\-().]{5,}$/.test(r)) return this.findByPhone(projectId, r, 'sms') ?? this.findByPhone(projectId, r, 'whatsapp');
    // Names and roles: inside a run the run's users win ("customer" = this run's customer); without one, project users only.
    const all = this.list(projectId, { runId: runId ?? null });
    const lower = r.toLowerCase();
    return (
      all.find((u) => u.name.toLowerCase() === lower) ??
      all.find((u) => u.role === lower) ??
      all.find((u) => u.email?.split('@')[0] === lower) ??
      null
    );
  }

  requireRef(projectId: string, ref: string, runId?: string | null): TestUser {
    const u = this.resolve(projectId, ref, runId);
    if (!u) throw new HttpError(404, `No test user matches "${ref}" (use an id, email, phone, name or role)`);
    return u;
  }

  delete(projectId: string, id: string): TestUser {
    const u = this.require(projectId, id);
    this.db.prepare('DELETE FROM test_users WHERE id = ?').run(id);
    return u;
  }

  /**
   * Generate users per role with fake but valid-looking contact details, e.g.
   * [{role:'admin',count:1},{role:'sales',count:2},{role:'customer',count:6}].
   * Numbering continues after existing users of the same role. The first new user of each role is pinned
   * while the pinned bar has fewer than `maxAutoPins` users.
   */
  generate(
    projectId: string,
    opts: { roles?: RoleCount[]; admins?: number; customers?: number; emailDomain: string; phonePrefix: string; password?: string | null; maxAutoPins?: number },
  ): TestUser[] {
    const roles: RoleCount[] = (opts.roles ?? [
      { role: 'admin', count: opts.admins ?? 1 },
      { role: 'customer', count: opts.customers ?? 9 },
    ])
      .map((r) => ({ role: normalizeRole(r.role), count: Math.max(0, Math.min(Math.floor(Number(r.count) || 0), 200)) }))
      .filter((r) => r.count > 0);
    const total = roles.reduce((n, r) => n + r.count, 0);
    if (total > 500) throw new HttpError(400, 'At most 500 users can be generated at once');
    const created: TestUser[] = [];
    const existing = this.list(projectId);
    const everyone = this.list(projectId, { all: true });
    const usedEmails = new Set(everyone.map((u) => u.email));
    const usedPhones = new Set(everyone.flatMap((u) => [u.phone, u.whatsapp]));
    let pins = existing.filter((u) => u.pinned > 0).length;
    const maxPins = opts.maxAutoPins ?? 4;
    let seq = existing.length + 1;
    const nextPhone = () => {
      // Pad so that prefix + digits is a plausible E.164 number (max 15 digits).
      const prefixDigits = opts.phonePrefix.replace(/[^\d]/g, '');
      const width = Math.max(4, 12 - prefixDigits.length);
      let p: string;
      do {
        p = '+' + prefixDigits + String(seq++).padStart(width, '0');
      } while (usedPhones.has(p));
      usedPhones.add(p);
      return p;
    };
    const nextEmail = (base: string) => {
      let i = 1;
      let e = `${base}@${opts.emailDomain}`;
      while (usedEmails.has(e)) e = `${base}-${++i}@${opts.emailDomain}`;
      usedEmails.add(e);
      return e;
    };
    this.db.transaction(() => {
      for (const { role, count } of roles) {
        const start = existing.filter((u) => u.role === role).length;
        const label = titleCase(role);
        const base = role.replace(/[^a-z0-9]+/g, '');
        // Staff-like roles read better as "Admin" / "Sales 2"; customers get a first name too.
        const personal = role === 'customer' || role === 'user';
        for (let k = 1; k <= count; k++) {
          const i = start + k;
          const single = start === 0 && count === 1 && !personal;
          const phone = nextPhone();
          const name = single ? label : personal ? `${FIRST_NAMES[(i - 1) % FIRST_NAMES.length]} (${label} ${i})` : `${label} ${i}`;
          const pin = k === 1 && pins < maxPins;
          if (pin) pins++;
          created.push(
            this.create(projectId, {
              name,
              role,
              email: nextEmail(single ? base : `${base}${i}`),
              phone,
              whatsapp: phone,
              password: opts.password ?? null,
              pinned: pin,
            }),
          );
        }
      }
    })();
    return created;
  }

  private checkUnique(
    projectId: string,
    v: { email: string | null; phone: string | null; whatsapp: string | null },
    exceptId?: string,
  ): void {
    const check = (col: string, value: string | null, label: string) => {
      if (!value) return;
      const r = this.db
        .prepare(`SELECT id, name FROM test_users WHERE project_id = ? AND ${col} = ? AND id != ?`)
        .get(projectId, value, exceptId ?? '') as { id: string; name: string } | undefined;
      if (r) throw new HttpError(409, `${label} ${value} is already used by test user "${r.name}" in this project`);
    };
    check('email', v.email, 'Email');
    check('phone', v.phone, 'Phone');
    check('whatsapp', v.whatsapp, 'WhatsApp number');
  }
}

function normalizeRole(role: string | undefined | null): string {
  return (role ?? '').trim().toLowerCase().replace(/\s+/g, '-') || 'user';
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
