import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createCookieClient } from '@/lib/supabase/server';
import { CreateOrg } from './CreateOrg';
import { SignOut } from './SignOut';
import { LinkButton } from '@/components/ui/controls';

const ROLE_LABEL: Record<string, string> = { owner: '소유자', admin: '관리자', agent: '상담원', viewer: '조회자' };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ pick?: string }> }) {
  const db = await createCookieClient();
  // RLS-scoped: a user only ever sees their own memberships and the orgs they belong to.
  const { data: ms } = await db.from('memberships').select('org_id, role');
  const ids = (ms ?? []).map((m) => m.org_id);
  const { data: orgs } = ids.length ? await db.from('organizations').select('id, name, slug').in('id', ids) : { data: [] };
  if (orgs?.length === 1 && !(await searchParams).pick) redirect(`/dashboard/orgs/${orgs[0].id}`);
  const role = (id: string) => ms?.find((m) => m.org_id === id)?.role ?? 'viewer';
  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10 md:py-16">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight"><span aria-hidden className="grid size-7 place-items-center rounded-lg bg-[#0075de] text-sm text-white">C</span>CSAI</Link>
        <SignOut />
      </header>
      <div><h1 className="display text-[32px]">조직 선택</h1><p className="mt-2 text-base text-[#615d59]">작업할 조직을 고르거나 새로 만드세요.</p></div>
      {orgs?.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {orgs.map((o) => (
            <li key={o.id} className="card flex flex-col gap-3 p-6">
              <div><div className="text-[22px] font-bold tracking-tight">{o.name}</div><div className="text-[#615d59]">{o.slug} · {ROLE_LABEL[role(o.id)]}</div></div>
              <LinkButton href={`/dashboard/orgs/${o.id}`} variant="ghost">열기</LinkButton>
            </li>
          ))}
        </ul>
      ) : <p className="text-[#615d59]">아직 속한 조직이 없습니다. 아래에서 조직을 만들거나, 초대 링크로 참여하세요.</p>}
      <CreateOrg />
    </main>
  );
}
