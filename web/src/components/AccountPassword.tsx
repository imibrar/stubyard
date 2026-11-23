import { useEffect, useRef, useState, type RefObject } from 'react';
import { changePassword, signOut, takeLastPassword, useAuth } from '../auth';
import { AuthFrame, PasswordInput, useDocTitle } from '../pages/LoginPage';
import { Icon } from './people';
import { Modal, useToast } from './ui';
import '../styles/team.css';

const MIN = 8;

/** Validation shared by the forced form and the dialog: null when the new password can be sent. */
function problem(current: string, next: string, confirm: string): string | null {
  if (!current) return 'Enter your current password.';
  if (next.length < MIN) return `The new password needs at least ${MIN} characters.`;
  if (next !== confirm) return 'The two new passwords do not match.';
  if (next === current) return 'Choose a password different from the current one.';
  return null;
}

function Fields({ current, setCurrent, next, setNext, confirm, setConfirm, showCurrent, firstRef }: {
  current: string;
  setCurrent: (v: string) => void;
  next: string;
  setNext: (v: string) => void;
  confirm: string;
  setConfirm: (v: string) => void;
  showCurrent: boolean;
  firstRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <>
      {showCurrent && (
        <label className="field">
          <span>Current password</span>
          <PasswordInput name="current-password" autoComplete="current-password" value={current} onChange={setCurrent} inputRef={firstRef} />
        </label>
      )}
      <label className="field">
        <span>
          New password <span className="hint">At least {MIN} characters</span>
        </span>
        <PasswordInput name="new-password" autoComplete="new-password" minLength={MIN} value={next} onChange={setNext} inputRef={showCurrent ? undefined : firstRef} />
      </label>
      <label className="field">
        <span>Repeat the new password</span>
        <PasswordInput name="confirm-password" autoComplete="new-password" minLength={MIN} value={confirm} onChange={setConfirm} />
      </label>
    </>
  );
}

/**
 * Teams: shown instead of the dashboard while the account has a temporary password (after the first sign-in or an
 * admin reset). The hub refuses everything else with 403 must_change_password until it is changed.
 */
export function ForcedPasswordPage() {
  const auth = useAuth();
  const [prefilled] = useState(() => takeLastPassword());
  const [current, setCurrent] = useState(prefilled);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useDocTitle('Choose a new password · stubyard');
  useEffect(() => firstRef.current?.focus(), []);

  const submit = async () => {
    const p = problem(current, next, confirm);
    if (p) return setError(p);
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <form
        className="card login-card"
        aria-labelledby="pw-title"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="login-head">
          <h1 id="pw-title">Choose a new password</h1>
          <p className="muted">
            {auth.user?.email ? <strong>{auth.user.email}</strong> : 'This account'} has a temporary password. Choose your own before you continue.
          </p>
        </div>
        {/* The temporary password just typed is prefilled; ask for it when the page was reloaded. */}
        <Fields current={current} setCurrent={setCurrent} next={next} setNext={setNext} confirm={confirm} setConfirm={setConfirm} showCurrent={!prefilled} firstRef={firstRef} />
        {error && (
          <p className="error-box login-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary login-submit" disabled={busy || !next || !confirm}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>
        <button type="button" className="btn ghost login-submit" onClick={() => void signOut()}>
          <Icon name="lock" size={14} /> Sign out
        </button>
      </form>
    </AuthFrame>
  );
}

/** Account menu → Change password (Teams, not the environment admin). Other sessions of the account end. */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const submit = async () => {
    const p = problem(current, next, confirm);
    if (p) return setError(p);
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast('Password changed. Your other sessions were signed out.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Change password"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="change-password-form" className="btn primary" disabled={busy || !current || !next || !confirm}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </>
      }
    >
      <form
        id="change-password-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Fields current={current} setCurrent={setCurrent} next={next} setNext={setNext} confirm={confirm} setConfirm={setConfirm} showCurrent firstRef={firstRef} />
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <p className="muted small" style={{ margin: 0 }}>
          Your other signed-in browsers are signed out; this one stays signed in.
        </p>
      </form>
    </Modal>
  );
}
