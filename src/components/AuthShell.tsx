import Link from 'next/link';
import type { ReactNode } from 'react';

// Shared frame for login / signup / invite: form card on the paper canvas, a flat midnight panel on desktop (DESIGN.md: no gradients).
export function AuthShell({ title, sub, children, footer }: { title: string; sub?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh md:grid-cols-[1fr_minmax(0,480px)] lg:grid-cols-2">
      <main id="main" className="flex flex-col px-4 py-6 md:px-12">
        <Link href="/" className="flex w-fit items-center gap-2 text-lg font-bold tracking-tight"><span aria-hidden className="grid size-7 place-items-center rounded-lg bg-[#0075de] text-sm text-white">C</span>CSAI</Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 py-10">
          <div><h1 className="display text-[32px]">{title}</h1>{sub && <p className="mt-2 text-base text-[#615d59]">{sub}</p>}</div>
          {children}
          {footer && <div className="text-sm text-[#615d59]">{footer}</div>}
        </div>
      </main>
      <aside aria-hidden className="hidden flex-col justify-between bg-[#02093a] p-12 text-white md:flex">
        <span className="w-fit rounded-full bg-[#ffb110] px-3 py-1 text-xs font-medium text-black">AI Customer Operations</span>
        <p className="display text-[40px]">모든 문의를 한 곳에서,<br />위험한 행동은 사람이 승인합니다.</p>
        <ul className="space-y-2 text-white/70"><li>· 이메일·웹 채팅 통합 Inbox</li><li>· 초대 기반 팀 관리</li><li>· 관리자 2단계 인증(MFA)</li></ul>
      </aside>
    </div>
  );
}
