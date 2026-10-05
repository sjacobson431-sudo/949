'use client';

import { useState } from 'react';
import { useSession } from '@/lib/session';

export function LockScreen() {
  const { status, unlock, init } = useSession();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creating = status && !status.initialized;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (creating && pw !== pw2) return setErr('Passwords do not match');
    setBusy(true);
    try {
      await (creating ? init(pw) : unlock(pw));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
      setPw('');
      setPw2('');
    }
  };

  return (
    <div className="lock">
      <form className="card" onSubmit={submit}>
        <h3>{creating ? 'Create encrypted vault' : 'Vault locked'}</h3>
        <p className="muted">
          {creating
            ? 'Choose a long passphrase (≥ 12 chars). It encrypts every private key locally (scrypt + AES-256-GCM). It cannot be recovered.'
            : 'Enter your vault password. Keys never leave this machine.'}
        </p>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Vault password" autoComplete={creating ? 'new-password' : 'current-password'} />
        {creating && <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Confirm password" autoComplete="new-password" />}
        {err && <div className="alert error">{err}</div>}
        <button className="primary" disabled={busy || !pw}>{busy ? 'Deriving key…' : creating ? 'Create vault' : 'Unlock'}</button>
      </form>
    </div>
  );
}
