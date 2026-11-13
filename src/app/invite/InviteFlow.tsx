'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowser } from '@/lib/supabase/browser';
import { AuthShell } from '@/components/AuthShell';
import { Button, Field } from '@/components/ui/controls';
import { CAPTCHA_ENABLED, Turnstile, type TurnstileHandle } from '@/components/Turnstile';

type Preview = { org_name: string; email: string; role: string; has_account: boolean; expires_at: string };
const ROLE: Record<string, string> = { owner: '소유자', admin: '관리자', agent: '상담원', viewer: '조회자' };
const post = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const shell = (title: string, children: React.ReactNode, sub?: string) => <AuthShell title={title} sub={sub}>{children}</AuthShell>;

export function InviteFlow({ token }: { token: string }) {
  const router = useRouter();
  const [p, setP] = useState<Preview | null | 'loading'>(token.length >= 20 ? 'loading' : null);   // null = invalid
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const ts = useRef<TurnstileHandle>(null);
  const onToken = useCallback((t: string | null) => setCaptcha(t), []);

  useEffect(() => {
    if (token.length < 20) return;
    post('/api/v1/invitations/preview', { token }).then(async (r) => setP(r.ok ? (await r.json()).data : null), () => setP(null));
  }, [token]);

  async function signInAndAccept(email: string, password: string) {
    const auth = createBrowser().auth;
    const { error } = await auth.signInWithPassword({ email, password, options: CAPTCHA_ENABLED ? { captchaToken: captcha ?? undefined } : undefined });
    ts.current?.reset();
    if (error) return setErr(error.code === 'captcha_failed' ? '보안 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.' : '이메일 또는 비밀번호가 올바르지 않습니다.');
    const r = await post('/api/v1/invitations/accept', { token });
    if (r.ok) { router.replace('/dashboard'); router.refresh(); return; }
    const code = (await r.json().catch(() => null))?.error?.code;
    setErr(code === 'conflict' ? '이미 이 조직의 구성원입니다.' : code === 'rate_limited' ? '잠시 후 다시 시도해 주세요.' : '초대를 수락할 수 없습니다. 만료되었거나 이미 사용된 초대일 수 있습니다.');
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!p || p === 'loading') return;
    const f = new FormData(e.currentTarget); const password = String(f.get('password'));
    setBusy(true); setErr(null);
    if (!p.has_account) {
      if (password !== String(f.get('confirm'))) { setErr('비밀번호가 서로 일치하지 않습니다.'); setBusy(false); return; }
      const r = await post('/api/v1/invitations/redeem', { token, password });
      if (!r.ok) {
        const code = (await r.json().catch(() => null))?.error?.code;
        setErr(code === 'weak_password' ? '더 안전한 비밀번호를 사용해 주세요.' : code === 'rate_limited' ? '잠시 후 다시 시도해 주세요.' : '계정을 만들 수 없습니다. 초대 링크를 다시 확인해 주세요.');
        setBusy(false); return;
      }
    }
    await signInAndAccept(p.email, password);
    setBusy(false);
  }

  if (p === 'loading') return shell('초대 확인 중', <p role="status" className="text-[var(--text-secondary)]">초대를 확인하는 중…</p>);
  if (!p) return shell('초대를 사용할 수 없습니다', <>
    <p className="text-[var(--text-secondary)]">링크가 만료되었거나 이미 사용·취소되었을 수 있습니다. 초대한 관리자에게 <strong>재발송</strong>을 요청해 주세요.</p>
    <Button type="button" variant="secondary" onClick={() => router.push('/login')}>로그인 화면으로</Button>
  </>);
  return shell(`${p.org_name}에 초대되었습니다`, <>
    <form onSubmit={onSubmit} className="card flex flex-col gap-4 p-6">
      <p className="text-[var(--text-secondary)]">{p.has_account ? '이미 계정이 있습니다. 비밀번호로 로그인하면 초대가 수락됩니다.' : '사용할 비밀번호를 설정하세요 (10자 이상).'}</p>
      <Field id="password" name="password" type="password" label={p.has_account ? '비밀번호' : '새 비밀번호'} autoComplete={p.has_account ? 'current-password' : 'new-password'} minLength={p.has_account ? 1 : 10} maxLength={128} required />
      {!p.has_account && <Field id="confirm" name="confirm" type="password" label="비밀번호 확인" autoComplete="new-password" minLength={10} maxLength={128} required />}
      <Turnstile ref={ts} onToken={onToken} />
      <div aria-live="polite" className="min-h-5 text-sm text-[var(--danger)]">{err}</div>
      <Button type="submit" disabled={busy || (CAPTCHA_ENABLED && !captcha)}>{busy ? '처리 중…' : p.has_account ? '로그인하고 수락' : '계정 만들고 수락'}</Button>
    </form>
  </>, `${p.email} · 역할: ${ROLE[p.role] ?? p.role} · ${p.expires_at.slice(0, 10)}까지 유효`);
}
