import Link from 'next/link';
import { AuthShell } from '@/components/AuthShell';
import { LoginForm } from '../login/LoginForm';
import { SIGNUP_OPEN } from '@/lib/signup-policy';
import { LinkButton } from '@/components/ui/controls';

export const metadata = { title: '가입하기 — CSAI' };

// Public sign-up is gated by the same flag as before; otherwise this page explains the invite-only flow (existing /invite link).
export default function SignupPage() {
  if (SIGNUP_OPEN) return <LoginForm mode="signup" next="/dashboard" />;
  return (
    <AuthShell title="초대로 시작하세요" sub="CSAI는 현재 초대 기반 베타입니다." footer={<>이미 계정이 있나요? <Link href="/login" className="font-medium text-[#0075de] underline">로그인</Link></>}>
      <div className="card flex flex-col gap-4 p-6">
        <p className="text-[#615d59]">조직 관리자가 보낸 초대 메일의 링크로 비밀번호를 설정하고 가입할 수 있습니다. 링크가 만료되었다면 관리자에게 재발송을 요청해 주세요.</p>
        <LinkButton href="/login">로그인하기</LinkButton>
      </div>
    </AuthShell>
  );
}
