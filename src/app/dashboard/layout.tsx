import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { createCookieClient } from '@/lib/supabase/server';
import { MfaGate } from './MfaGate';

export const dynamic = 'force-dynamic';

// Server-side guard (the proxy is only a first line): no valid session => /login, before any dashboard markup renders.
// App chrome (sidebar/header) lives in orgs/[id]/layout.tsx; this layout only authenticates and applies the MFA gate.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const db = await createCookieClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect('/login?next=/dashboard');
  // Owner/admin accounts must be MFA-verified (aal2) before the dashboard renders; the DB and API enforce the same rule independently.
  const { data: ms } = await db.from('memberships').select('role');
  const privileged = (ms ?? []).some((m) => m.role === 'owner' || m.role === 'admin');
  const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  const gated = privileged && aal?.currentLevel !== 'aal2';
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:p-2">본문으로 건너뛰기</a>
      {gated ? <MfaGate hasFactor={aal?.nextLevel === 'aal2'} /> : children}   {/* MfaGate renders its own <main id="main"> inside the auth frame */}
    </>
  );
}
