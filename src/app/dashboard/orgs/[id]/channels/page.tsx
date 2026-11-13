import { orgCtx } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { ChannelsAdmin, type Channel } from './ChannelsAdmin';

export default async function ChannelsPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, id: orgId, admin } = await orgCtx(params);
  const { data } = admin ? await db.from('channel_accounts').select('id,kind,name,address,status,public_key,config').eq('org_id', orgId).order('created_at') : { data: [] };
  return (
    <div>
      <PageHeader title="채널·연동" desc="고객 문의가 들어오는 이메일 주소와 웹 채팅 위젯을 관리합니다." />
      {admin ? <ChannelsAdmin orgId={orgId} channels={(data ?? []) as Channel[]} /> : <p className="card p-5 text-[var(--text-secondary)]">채널 설정은 소유자·관리자만 볼 수 있습니다.</p>}
    </div>
  );
}
