'use client';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowser } from '@/lib/supabase/browser';
import { Button, Field } from '@/components/ui/controls';
import { SIGNUP_OPEN } from '@/lib/signup-policy';
import Link from 'next/link';
import { AuthShell } from '@/components/AuthShell';
import { CAPTCHA_ENABLED, Turnstile, type TurnstileHandle } from '@/components/Turnstile';

type Msg = { kind: 'error' | 'info'; text: string } | null;

export function LoginForm({ next, mode = 'signin' }: { next: string; mode?: 'signin' | 'signup' }) {
  const router = useRouter();
  const signin = mode === 'signin';
  const [step, setStep] = useState<{ factorId: string } | null>(null);   // second step: TOTP code (only for accounts that enrolled MFA, i.e. admins)
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const ts = useRef<TurnstileHandle>(null);
  const onToken = useCallback((t: string | null) => setCaptcha(t), []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email')), password = String(f.get('password'));
    setBusy(true); setMsg(null);
    const auth = createBrowser().auth;
    const options = CAPTCHA_ENABLED ? { captchaToken: captcha ?? undefined } : undefined;
    if (signin) {
      const { error } = await auth.signInWithPassword({ email, password, options });
      ts.current?.reset();                                                  // captcha tokens are single-use
      if (error) setMsg({ kind: 'error', text: error.code === 'captcha_failed' ? '보안 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.' : '이메일 또는 비밀번호가 올바르지 않습니다.' }); // no account enumeration
      else {
        const { data } = await auth.mfa.getAuthenticatorAssuranceLevel();
        if (data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2') {
          const { data: fs } = await auth.mfa.listFactors();
          const factor = fs?.totp?.[0];
          if (factor) { setStep({ factorId: factor.id }); setBusy(false); return; }
        }
        router.replace(next); router.refresh();
      }
    } else {
      await auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/login`, ...options } });
      ts.current?.reset();
      setMsg({ kind: 'info', text: '입력하신 주소로 확인 메일을 보냈습니다. 메일의 링크로 인증한 뒤 로그인해 주세요.' }); // same text whether or not the address exists
    }
    setBusy(false);
  }

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code')).trim();
    setBusy(true); setMsg(null);
    const { error } = await createBrowser().auth.mfa.challengeAndVerify({ factorId: step!.factorId, code });
    if (error) { setMsg({ kind: 'error', text: '인증 코드가 올바르지 않습니다.' }); setBusy(false); return; }
    router.replace(next); router.refresh();
  }

  if (step) {
    return (
      <AuthShell title="2단계 인증" sub="인증 앱에 표시된 6자리 코드를 입력하세요.">
        <form key="mfa-step" onSubmit={onVerify} className="card flex flex-col gap-4 p-6">
          <Field id="code" name="code" label="인증 앱의 6자리 코드" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus />
          <div aria-live="polite" className="min-h-5 text-sm text-[var(--danger)]">{msg?.text}</div>
          <Button type="submit" disabled={busy}>{busy ? '확인 중…' : '확인'}</Button>
        </form>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={signin ? '다시 만나서 반가워요' : '계정 만들기'} sub={signin ? '이메일과 비밀번호로 로그인하세요.' : '이메일로 확인 메일을 보내드립니다.'}
      footer={signin
        ? (SIGNUP_OPEN ? <>계정이 없나요? <Link href="/signup" className="font-medium text-[#0075de] underline">가입하기</Link></> : '초대를 받은 경우에만 가입할 수 있습니다. 초대 메일의 링크를 이용하거나 관리자에게 문의해 주세요.')
        : <>이미 계정이 있나요? <Link href="/login" className="font-medium text-[#0075de] underline">로그인</Link></>}>
      <form key="login-step" onSubmit={onSubmit} className="card flex flex-col gap-4 p-6">
        <Field id="email" name="email" type="email" label="이메일" autoComplete="email" required />
        <Field id="password" name="password" type="password" label="비밀번호" autoComplete={signin ? 'current-password' : 'new-password'} minLength={8} required />
        <Turnstile ref={ts} onToken={onToken} />
        <div aria-live="polite" className={`min-h-5 text-sm ${msg?.kind === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'}`}>{msg?.text}</div>
        <Button type="submit" disabled={busy || (CAPTCHA_ENABLED && !captcha)}>{busy ? '처리 중…' : signin ? '로그인' : '가입하기'}</Button>
      </form>
    </AuthShell>
  );
}
