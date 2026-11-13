import { orgCtx } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/ui/data';
import { OrgAdmin, type Invitation, type Member } from '../OrgAdmin';

const ROLE_HELP = [['소유자', '모든 설정·멤버 관리(관리자 초대 포함)'], ['관리자', '조직 설정, 상담원·조회자 초대·관리'], ['상담원', '대화 응대(Inbox)'], ['조회자', '읽기 전용']];

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, id, me, admin } = await orgCtx(params);
  const { data: org } = await db.from('organizations').select('name').eq('id', id).single();
  const { data: ms } = await db.rpc('list_members', { p_org: id });
  const members: Member[] = ((ms ?? []) as { out_id: string; out_user_id: string; out_email: string; out_role: string }[]).map((m) => ({ id: m.out_id, userId: m.out_user_id, email: m.out_email, role: m.out_role }));
  const { data: invs } = admin ? await db.from('invitations').select('id,email,role,status,expires_at').eq('org_id', id).order('created_at', { ascending: false }).limit(50) : { data: [] };
  return (
    <>
      <PageHeader title="팀 관리" desc="멤버를 초대하고 역할을 확인합니다. 소유자·관리자 계정은 2단계 인증(TOTP)이 필요합니다." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <OrgAdmin part="team" orgId={id} orgName={org?.name ?? ''} role={me.role} meId={me.user_id} members={members} invitations={(invs ?? []) as Invitation[]} />
        <Section title="역할 설명" className="h-fit"><dl className="space-y-3 p-5">{ROLE_HELP.map(([r, d]) => <div key={r}><dt className="font-medium">{r}</dt><dd className="text-sm text-[#615d59]">{d}</dd></div>)}</dl></Section>
      </div>
    </>
  );
}
