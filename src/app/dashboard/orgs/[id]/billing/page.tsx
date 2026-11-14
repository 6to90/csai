import { orgCtx } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/ui/controls';
import { Section, StatCard } from '@/components/ui/data';

// 결제 제공업체·구독 테이블·Webhook은 아직 없다(PRD: 결제 범위 밖). 이 화면은 실제 데이터(사용량)만 보여 주고,
// 결제 관련 영역은 "베타 기간 미제공"으로 비활성 표시한다. 가격·한도는 정의되지 않아 표시하지 않는다.
const BETA = <Pill color="bg-[#f6f5f4] text-[#615d59]">베타 기간 미제공</Pill>;
const PLANS = [
  { name: 'Starter', desc: '소규모 팀을 위한 기본 플랜', current: true },
  { name: 'Team', desc: '여러 채널과 팀원을 운영하는 팀', current: false },
  { name: 'Business', desc: '승인 정책·감사가 필요한 조직', current: false },
];
const off = 'min-h-9 cursor-not-allowed rounded-md border border-dashed border-[var(--border-strong)] px-3 text-sm text-[var(--text-muted)]';

export default async function BillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, id } = await orgCtx(params);
  const head = { count: 'exact', head: true } as const;
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const [mems, chans, convs] = await Promise.all([
    db.rpc('list_members', { p_org: id }),
    db.from('channel_accounts').select('id', head).eq('org_id', id),
    db.from('conversations').select('id', head).eq('org_id', id).gte('created_at', month.toISOString()),
  ]);
  const usage: [string, number, string][] = [['팀원', (mems.data ?? []).length, '명'], ['채널', chans.count ?? 0, '개'], ['이번 달 대화', convs.count ?? 0, '건']];
  return (
    <>
      <PageHeader title="결제·구독" desc="현재 플랜과 사용량을 확인합니다. 결제 기능은 베타 기간에 제공되지 않습니다." />
      <div className="grid max-w-5xl gap-6">
        <Section title="현재 구독" action={<Pill color="bg-[#e6f3fe] text-[#004a8f]">베타 무료</Pill>}>
          <div className="grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <div className="text-2xl font-semibold tracking-tight">Starter</div>
              <p className="mt-2 max-w-xl text-sm text-[#615d59]">초대 기반 베타 기간에는 요금이 청구되지 않으며, 구독 상태가 자동으로 바뀌지 않습니다. 유료 플랜이 시작되기 전에 별도로 안내합니다.</p>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <dt className="text-[#757575]">청구 금액</dt><dd>₩0 (청구 없음)</dd>
              <dt className="text-[#757575]">다음 결제일</dt><dd>없음</dd>
              <dt className="text-[#757575]">결제 상태</dt><dd>해당 없음</dd>
            </dl>
          </div>
        </Section>

        <section aria-label="사용량">
          <h2 className="mb-2 text-sm font-semibold">사용량 <span className="ml-1 text-xs font-normal text-[#757575]">플랜 한도는 아직 정해지지 않았습니다</span></h2>
          <div className="grid gap-3 sm:grid-cols-3">{usage.map(([l, n, u]) => <StatCard key={l} label={l} value={`${n}${u}`} desc="한도 미정" />)}</div>
        </section>

        <Section title="요금제 비교" desc="가격과 한도는 곧 공개됩니다." action={BETA}>
          <ul className="grid gap-3 p-5 md:grid-cols-3">
            {PLANS.map((p) => (
              <li key={p.name} className={`rounded-md border p-4 ${p.current ? 'border-[#0075de] bg-[#e6f3fe]/40' : 'border-[var(--border)] bg-white'}`}>
                <div className="flex items-center justify-between gap-2"><span className="font-semibold">{p.name}</span>{p.current && <Pill color="bg-[#e6f3fe] text-[#004a8f]">현재 플랜</Pill>}</div>
                <p className="mt-1 text-sm text-[#615d59]">{p.desc}</p>
                <p className="mt-3 text-lg font-semibold text-[#757575]">곧 공개</p>
                <button type="button" disabled aria-disabled="true" className={`${off} mt-3 w-full`}>{p.current ? '사용 중' : '플랜 변경 (준비 중)'}</button>
              </li>))}
          </ul>
        </Section>

        <div className="grid gap-6 md:grid-cols-2">
          <Section title="결제 수단" action={BETA}>
            <div className="grid gap-3 p-5 text-sm text-[#615d59]"><p>등록된 결제 수단이 없습니다. 베타 기간에는 결제 수단이 필요하지 않습니다.</p><button type="button" disabled aria-disabled="true" className={`${off} w-fit`}>결제 수단 추가</button></div>
          </Section>
          <Section title="구독 관리" action={BETA}>
            <div className="grid gap-3 p-5 text-sm text-[#615d59]"><p>구독 취소·갱신과 결제 실패 시 재결제 안내는 유료 플랜이 시작되면 이곳에 표시됩니다.</p><div className="flex flex-wrap gap-2"><button type="button" disabled aria-disabled="true" className={off}>구독 취소</button><button type="button" disabled aria-disabled="true" className={off}>재결제</button></div></div>
          </Section>
        </div>

        <Section title="청구 내역·영수증" action={BETA}>
          <div className="p-5 text-sm text-[#615d59]">발행된 청구서가 없습니다. 유료 플랜이 시작되면 청구서와 영수증이 이곳에 표시됩니다.</div>
        </Section>
      </div>
    </>
  );
}
