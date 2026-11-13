import { orgCtx } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { Inbox } from './Inbox';

export default async function InboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, id: orgId, me } = await orgCtx(params);
  const { data: ms } = await db.rpc('list_members', { p_org: orgId });
  const members = ((ms ?? []) as { out_user_id: string; out_email: string; out_role: string }[]).filter((m) => m.out_role !== 'viewer').map((m) => ({ id: m.out_user_id, email: m.out_email }));
  return (
    <div className="flex flex-col gap-1">
      <PageHeader title="통합 Inbox" compact />
      <Inbox orgId={orgId} meId={me.user_id} canAct={me.role !== 'viewer'} members={members} />
    </div>
  );
}
