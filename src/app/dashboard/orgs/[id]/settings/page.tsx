import { orgCtx, ROLE_LABEL } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/ui/data';
import { OrgAdmin } from '../OrgAdmin';

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, id, me, admin } = await orgCtx(params);
  const { data: org } = await db.from('organizations').select('name,slug,data_retention_days,kill_switch').eq('id', id).single();
  const rows: [string, string][] = [['주소(slug)', org?.slug ?? ''], ['내 역할', ROLE_LABEL[me.role]], ['데이터 보존 기간', `${org?.data_retention_days}일`]];
  return (
    <>
      <PageHeader title="설정" desc="조직 정보와 보안 정책을 확인하고 관리합니다." />
      <div className="grid max-w-3xl gap-6">
        <Section title="조직 정보" desc="조직의 기본 정보입니다.">
          <dl className="grid grid-cols-[140px_1fr] gap-y-3 p-5 text-sm">{rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-[#615d59]">{k}</dt><dd className="break-all">{v}</dd></div>)}</dl>
        </Section>
        <OrgAdmin part="settings" orgId={id} orgName={org?.name ?? ''} role={me.role} meId={me.user_id} members={[]} invitations={[]} />
        <Section title="보안" desc="인증과 AI 안전장치 상태입니다.">
          <dl className="grid grid-cols-[140px_1fr] gap-y-3 p-5 text-sm">
            <dt className="text-[#615d59]">2단계 인증</dt><dd>소유자·관리자는 인증 앱(TOTP) 확인이 필수입니다. 서버와 DB가 각각 강제합니다.</dd>
            <dt className="text-[#615d59]">AI 긴급 중지</dt><dd>{org?.kill_switch ? '켜짐' : '꺼짐'} <span className="text-[#615d59]">(AI 에이전트 출시 후 이 화면에서 제어합니다)</span></dd>
          </dl>
        </Section>
        {!admin && <p className="text-sm text-[#615d59]">조직 설정 변경은 소유자·관리자만 할 수 있습니다.</p>}
      </div>
    </>
  );
}
