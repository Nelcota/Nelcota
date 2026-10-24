'use client';
import { useState } from 'react';
import { refreshSession } from '@nelcota/nextjs/browser';
export default function Refresh() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function renew() {
    setPending(true); setError('');
    try {
      const response = await refreshSession();
      if (!response.ok) { window.location.assign('/login'); return; }
      window.location.assign('/profile');
    } catch { setError('Could not renew the session. Try again.'); }
    finally { setPending(false); }
  }
  return <main><h1>Continue your session</h1><p>Renew the session before returning to your profile.</p><button disabled={pending} onClick={renew}>{pending ? 'Renewing…' : 'Continue'}</button><p role="status">{error}</p></main>;
}
