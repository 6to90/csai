import { orgCtx, STATUS_LABEL } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { ScrollEnd } from './ScrollEnd';
import { Section, StatCard } from '@/components/ui/data';

const DAYS = 14;
const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)}분` : m < 1440 ? `${(m / 60).toFixed(1)}시간` : `${(m / 1440).toFixed(1)}일`);

function Bars({ rows, total }: { rows: [string, number][]; total: number }) { return rows.length ? <ul className="space-y-3">{rows.map(([k, n]) => <li key={k}><div className="mb-1 flex justify-between text-sm"><span>{k}</span><span className="text-[#615d59]">{n}</span></div><svg aria-hidden width="100%" height="8"><rect width="100%" height="8" rx="4" fill="#f6f5f4" /><rect width={`${(n / total) * 100}%`} height="8" rx="4" fill="#0075de" /></svg></li>)}</ul> : <p className="text-[#615d59]">데이터가 없습니다.</p>; }

export default async function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, id } = await orgCtx(params);
  const now = new Date(); const since = new Date(now.getTime() - 30 * 864e5).toISOString();
  const [{ data: convs }, { data: chans }] = await Promise.all([
    db.from('conversations').select('status,created_at,first_response_at,channel_account_id').eq('org_id', id).gte('created_at', since).limit(5000),
    db.from('channel_accounts').select('id,name,kind').eq('org_id', id),
  ]);
  const list = convs ?? [];
  const total = list.length;
  const resolved = list.filter((c) => c.status === 'resolved' || c.status === 'closed').length;
  const frt = list.filter((c) => c.first_response_at).map((c) => (+new Date(c.first_response_at!) - +new Date(c.created_at)) / 6e4);
  const avg = frt.length ? frt.reduce((a, b) => a + b, 0) / frt.length : null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: DAYS }, (_, i) => { const d = new Date(+today - (DAYS - 1 - i) * 864e5); return { key: d.toDateString(), label: `${d.getMonth() + 1}/${d.getDate()}`, n: 0 }; });
  for (const c of list) { const d = days.find((x) => x.key === new Date(c.created_at).toDateString()); if (d) d.n++; }
  const max = Math.max(1, ...days.map((d) => d.n));
  const by = (f: (c: (typeof list)[number]) => string) => Object.entries(list.reduce<Record<string, number>>((a, c) => { const k = f(c); a[k] = (a[k] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]);
  const byStatus = by((c) => STATUS_LABEL[c.status] ?? c.status);
  const byChannel = by((c) => chans?.find((x) => x.id === c.channel_account_id)?.name ?? '삭제된 채널');
  const kpi: [string, string][] = [['신규 대화 (30일)', String(total)], ['해결률', total ? `${Math.round((resolved / total) * 100)}%` : '—'], ['평균 첫 응답 시간', avg === null ? '—' : fmtMin(avg)]];
  return (
    <>
      <PageHeader title="분석" desc="최근 30일 대화 데이터를 실시간으로 집계합니다. AI 처리율·비용 지표는 AI 에이전트 출시 후 추가됩니다." />
      <section aria-label="핵심 지표" className="grid gap-3 sm:grid-cols-3">{kpi.map(([l, v], i) => <StatCard key={l} label={l} value={v} hot={i === 0} />)}</section>
      <Section title="일별 신규 대화" desc="최근 14일" className="mt-4">
        <ScrollEnd label="일별 신규 대화 차트 (좌우 스크롤)">
        <svg role="img" aria-label={`일별 신규 대화: ${days.map((d) => `${d.label} ${d.n}건`).join(', ')}`} viewBox={`0 0 ${DAYS * 40} 150`} className="h-40 w-full min-w-[560px] p-5 md:h-52">
          {days.map((d, i) => { const h = Math.round((d.n / max) * 120); return (<g key={d.key}><rect x={i * 40 + 6} y={125 - h} width="28" height={h} rx="3" fill="#0075de" /><text x={i * 40 + 20} y="145" textAnchor="middle" fontSize="11" fill="#615d59">{d.label.split('/')[1]}</text></g>); })}
        </svg>
        </ScrollEnd>
      </Section>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Section title="상태별"><div className="p-5"><Bars rows={byStatus} total={total} /></div></Section>
        <Section title="채널별"><div className="p-5"><Bars rows={byChannel} total={total} /></div></Section>
      </div>
    </>
  );
}
