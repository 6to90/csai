'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowser } from '@/lib/supabase/browser';
import { AuthShell } from '@/components/AuthShell';
import { Button, Field } from '@/components/ui/controls';
import { SignOut } from './SignOut';

/** Shown instead of the dashboard to owner/admin accounts whose session is not MFA-verified (aal2). Agents/viewers never see it. */
export function MfaGate({ hasFactor }: { hasFactor: boolean }) {
  const router = useRouter();
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true); setErr(null);
    const mfa = createBrowser().auth.mfa;
    const { data: list } = await mfa.listFactors();
    for (const f of list?.all ?? []) if (f.status === 'unverified') await mfa.unenroll({ factorId: f.id });   // clean up abandoned enrollments
    const { data, error } = await mfa.enroll({ factorType: 'totp', friendlyName: `authenticator-${Date.now()}` });
    setBusy(false);
    if (error || !data) { setErr('설정을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.'); return; }
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code')).trim();
    setBusy(true); setErr(null);
    const mfa = createBrowser().auth.mfa;
    let factorId = enroll?.id;
    if (!factorId) factorId = (await mfa.listFactors()).data?.totp?.[0]?.id;
    const { error } = factorId ? await mfa.challengeAndVerify({ factorId, code }) : { error: new Error('no factor') };
    setBusy(false);
    if (error) { setErr('인증 코드가 올바르지 않습니다.'); return; }
    router.refresh();
  }

  return (
    <AuthShell title="관리자 2단계 인증이 필요합니다" sub="소유자·관리자 권한을 사용하려면 인증 앱(TOTP)으로 확인해야 합니다." footer={<SignOut />}>
      <div className="card flex flex-col gap-4 p-6">
        {!hasFactor && !enroll && <Button onClick={start} disabled={busy}>인증 앱 설정 시작</Button>}
        {enroll && (
          <div className="flex flex-col gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URI SVG from Supabase Auth */}
            <img src={enroll.qr} alt="인증 앱에서 스캔할 QR 코드" width={192} height={192} className="rounded-md bg-white p-2" />
            <p className="text-sm text-[var(--text-secondary)]">QR을 스캔할 수 없다면 이 키를 직접 입력하세요: <code className="break-all text-[var(--text-primary)]">{enroll.secret}</code></p>
          </div>
        )}
        {(hasFactor || enroll) && (
          <form onSubmit={verify} className="flex flex-col gap-4">
            <Field id="mfa-code" name="code" label="인증 앱의 6자리 코드" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
            <Button type="submit" disabled={busy}>{busy ? '확인 중…' : '확인'}</Button>
          </form>
        )}
        <div aria-live="polite" className="min-h-5 text-sm text-[var(--danger)]">{err}</div>
      </div>
    </AuthShell>
  );
}
