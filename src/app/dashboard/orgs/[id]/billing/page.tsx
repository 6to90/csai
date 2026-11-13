import { orgCtx } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/ui/controls';
import { Section, StatCard } from '@/components/ui/data';

export default async function BillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, id } = await orgCtx(params);
  const head = { count: 'exact', head: true } as const;
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const [mems, chans, convs] = await Promise.all([
    db.rpc('list_members', { p_org: id }),
    db.from('channel_accounts').select('id', head).eq('org_id', id),
    db.from('conversations').select('id', head).eq('org_id', id).gte('created_at', month.toISOString()),
  ]);
  const usage: [string, number][] = [['팀원', (mems.data ?? []).length], ['채널', chans.count ?? 0], ['이번 달 대화', convs.count ?? 0]];
  return (
    <>
      <PageHeader title="결제·구독" desc="현재 플랜과 사용량을 확인합니다." />
      <div className="grid max-w-4xl gap-6">
        <Section title="현재 플랜" action={<Pill color="bg-[#e6f3fe] text-[#004a8f]">베타</Pill>}>
          <div className="p-5">
            <div className="text-2xl font-semibold tracking-tight">Starter · 베타 무료</div>
            <p className="mt-2 max-w-xl text-sm text-[#615d59]">초대 기반 베타 기간에는 요금이 청구되지 않습니다. 유료 플랜, 청구서, 결제 수단 등록은 아직 제공되지 않습니다.</p>
          </div>
        </Section>
        <section aria-label="사용량" className="grid gap-3 sm:grid-cols-3">{usage.map(([l, n]) => <StatCard key={l} label={l} value={n} />)}</section>
      </div>
    </>
  );
}
