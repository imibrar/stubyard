import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Authenticator, type AuthenticatorList, type TestUser } from '../api';
import { useHubEvents } from '../hooks';
import { Badge, Empty, ErrorBox, Modal, useCopy, useToast } from './ui';

/** Fetches codes and refreshes them exactly when a period rolls over. */
export function useAuthenticatorCodes(slug: string) {
  const [data, setData] = useState<AuthenticatorList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const offset = useRef(0); // server time - local time
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<AuthenticatorList>(`/api/projects/${slug}/authenticators`);
      offset.current = d.serverTime - Date.now();
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tick every 250 ms for the countdown; reload when any code has expired.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset.current), 250);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!data?.items.length) return;
    const nextExpiry = Math.min(...data.items.map((a) => a.current.validUntil));
    const wait = Math.max(0, nextExpiry - (Date.now() + offset.current)) + 50;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), wait);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [data, load]);

  useHubEvents(slug, (e) => {
    if (e.type === 'authenticator.changed' || e.type === 'user.changed') void load();
  });

  return { data, error, now, reload: load };
}

export function AuthenticatorsTab({ slug, users }: { slug: string; users: TestUser[] }) {
  const { data, error, now, reload } = useAuthenticatorCodes(slug);
  const [editing, setEditing] = useState<Authenticator | 'new' | null>(null);
  const items = data?.items ?? [];

  return (
    <div className="stack">
      <div className="row">
        <p className="muted grow" style={{ margin: 0 }}>
          Works like Google/Microsoft Authenticator: add the secret key (or the <code>otpauth://</code> link from the QR code) your app shows when
          enabling 2FA, and devhub shows the current code.
        </p>
        <button className="btn primary" onClick={() => setEditing('new')}>
          Add key
        </button>
      </div>
      <div className="info-box small">
        Use this only for <b>test accounts</b>. Keys are stored unencrypted in devhub's data volume.
      </div>
      <ErrorBox error={error} />
      {data && items.length === 0 && (
        <div className="card">
          <Empty title="No authenticator keys">
            When your app shows "Scan this QR code", click "Can't scan?" or similar to see the secret key, then add it here.
          </Empty>
        </div>
      )}
      <div className="grid grid-cards">
        {items.map((a) => (
          <AuthenticatorCard key={a.id} a={a} now={now} user={users.find((u) => u.id === a.testUserId)} onEdit={() => setEditing(a)} />
        ))}
      </div>
      {editing && (
        <AuthenticatorModal slug={slug} users={users} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />
      )}
    </div>
  );
}

export function AuthenticatorCard({
  a,
  now,
  user,
  onEdit,
  compact,
}: {
  a: Authenticator & { current: AuthenticatorList['items'][number]['current'] };
  now: number;
  user?: TestUser;
  onEdit?: () => void;
  compact?: boolean;
}) {
  const copy = useCopy();
  const expired = now >= a.current.validUntil;
  const remaining = Math.max(0, (a.current.validUntil - now) / 1000);
  const pct = Math.min(100, (remaining / a.current.period) * 100);
  const urgent = remaining <= 5;
  const code = expired ? a.current.nextCode : a.current.code;

  return (
    <div className={`card auth-card ${compact ? 'compact' : ''}`}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ellipsis" style={{ fontWeight: 600 }}>
            {a.label}
          </div>
          {!compact && (
            <div className="small muted ellipsis">{[a.issuer, a.account].filter(Boolean).join(' · ') || <span className="faint">No issuer</span>}</div>
          )}
        </div>
        {onEdit && (
          <button className="btn sm ghost" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
      <button className={`totp ${urgent ? 'urgent' : ''}`} onClick={() => copy(code, 'Code copied')} title="Click to copy">
        {group(code)}
      </button>
      <div className="totp-bar">
        <span style={{ width: `${pct}%` }} className={urgent ? 'urgent' : ''} />
      </div>
      <div className="row small muted">
        <span>{Math.ceil(remaining)}s left</span>
        <span className="faint">· next {group(a.current.nextCode)}</span>
        <span className="spacer" />
        {!compact && user && <Badge>{user.name}</Badge>}
        {!compact && (a.digits !== 6 || a.period !== 30 || a.algorithm !== 'SHA1') && (
          <Badge>
            {a.digits} digits · {a.period}s · {a.algorithm}
          </Badge>
        )}
      </div>
    </div>
  );
}

function group(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

function AuthenticatorModal({
  slug,
  users,
  item,
  onClose,
  onSaved,
}: {
  slug: string;
  users: TestUser[];
  item: Authenticator | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const copy = useCopy();
  const [form, setForm] = useState({
    label: item?.label ?? '',
    secret: '',
    testUserId: item?.testUserId ?? '',
    issuer: item?.issuer ?? '',
    account: item?.account ?? '',
    algorithm: item?.algorithm ?? 'SHA1',
    digits: item?.digits ?? 6,
    period: item?.period ?? 30,
  });
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isUri = form.secret.trim().toLowerCase().startsWith('otpauth:');

  const save = async () => {
    setError(null);
    const body: Record<string, unknown> = {
      label: form.label,
      testUserId: form.testUserId || null,
      issuer: form.issuer || null,
      account: form.account || null,
    };
    if (form.secret.trim()) body.secret = form.secret;
    if (!isUri) Object.assign(body, { algorithm: form.algorithm, digits: form.digits, period: form.period });
    try {
      if (item) await api.patch(`/api/projects/${slug}/authenticators/${item.id}`, body);
      else await api.post(`/api/projects/${slug}/authenticators`, body);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!item || !confirm(`Delete authenticator key "${item.label}"?`)) return;
    await api.del(`/api/projects/${slug}/authenticators/${item.id}`);
    toast('Key deleted');
    onSaved();
    onClose();
  };
  const copyLink = async () => {
    if (!item) return;
    const s = await api.get<{ otpauthUri: string }>(`/api/projects/${slug}/authenticators/${item.id}/secret`);
    copy(s.otpauthUri, 'otpauth:// link copied');
  };

  return (
    <Modal
      title={item ? 'Edit authenticator key' : 'Add authenticator key'}
      onClose={onClose}
      footer={
        <>
          {item && (
            <>
              <button className="btn danger" onClick={remove}>
                Delete
              </button>
              <button className="btn" onClick={copyLink} style={{ marginRight: 'auto' }}>
                Copy otpauth link
              </button>
            </>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!item && !form.secret.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
        <ErrorBox error={error} />
        <label className="field">
          Label <span className="hint">e.g. "Admin 2FA" or "Driver app login"</span>
          <input autoFocus value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Admin 2FA" />
        </label>
        <label className="field">
          {item ? 'Replace secret key (optional)' : 'Secret key or otpauth:// link'}
          <span className="hint">Paste the key exactly as your app shows it (spaces are fine), or the full otpauth://totp/… link.</span>
          <textarea
            className="mono"
            rows={2}
            value={form.secret}
            onChange={(e) => setForm({ ...form, secret: e.target.value })}
            placeholder={item ? `Current key ends with ${item.secretHint}` : 'JBSW Y3DP EHPK 3PXP   or   otpauth://totp/Hyper:admin?secret=…'}
          />
        </label>
        <label className="field">
          Test user <span className="hint">Optional — shows the code on that user's page</span>
          <select value={form.testUserId} onChange={(e) => setForm({ ...form, testUserId: e.target.value })}>
            <option value="">— none —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </select>
        </label>
        {!isUri && (
          <button type="button" className="btn sm ghost" style={{ justifySelf: 'start' }} onClick={() => setAdvanced(!advanced)}>
            {advanced ? '▾' : '▸'} Advanced (issuer, digits, period, algorithm)
          </button>
        )}
        {isUri && <p className="small muted" style={{ margin: 0 }}>Settings are read from the link.</p>}
        {advanced && !isUri && (
          <>
            <div className="form form-2">
              <label className="field">
                Issuer
                <input value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="Hyper" />
              </label>
              <label className="field">
                Account
                <input value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} placeholder="admin@hyper.test" />
              </label>
            </div>
            <div className="form" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              <label className="field">
                Digits
                <select value={form.digits} onChange={(e) => setForm({ ...form, digits: Number(e.target.value) })}>
                  <option value={6}>6</option>
                  <option value={7}>7</option>
                  <option value={8}>8</option>
                </select>
              </label>
              <label className="field">
                Period (s)
                <input type="number" min={10} max={300} value={form.period} onChange={(e) => setForm({ ...form, period: Number(e.target.value) })} />
              </label>
              <label className="field">
                Algorithm
                <select value={form.algorithm} onChange={(e) => setForm({ ...form, algorithm: e.target.value as Authenticator['algorithm'] })}>
                  <option>SHA1</option>
                  <option>SHA256</option>
                  <option>SHA512</option>
                </select>
              </label>
            </div>
            <p className="small faint" style={{ margin: 0 }}>
              Almost all apps use 6 digits, 30 seconds, SHA1 — only change these if your app says otherwise.
            </p>
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
