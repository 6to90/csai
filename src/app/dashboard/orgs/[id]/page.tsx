import Link from 'next/link';
import { orgCtx, STATUS_LABEL } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { LinkButton } from '@/components/ui/controls';
import { EmptyState, Section, StatCard, StatusPill } from '@/components/ui/data';

const count = (r: { count: number | null }) => r.count ?? 0;

export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { db, id, base, admin } = await orgCtx(params);
  const head = { count: 'exact', head: true } as const;
  const [open, unassigned, waiting, chans, mems, recent, unread] = await Promise.all([
    db.from('conversations').select('id', head).eq('org_id', id).eq('status', 'open'),
    db.from('conversations').select('id', head).eq('org_id', id).eq('status', 'open').is('assignee_id', null),
    db.from('conversations').select('id', head).eq('org_id', id).in('status', ['pending_approval', 'waiting_customer']),
    db.from('channel_accounts').select('id', head).eq('org_id', id),
    db.rpc('list_members', { p_org: id }),
    db.from('conversations').select('id,status,subject,last_message_at,last_message_preview,unread_count,customer_id').eq('org_id', id).order('last_message_at', { ascending: false, nullsFirst: false }).limit(8),
    db.from('conversations').select('unread_count').eq('org_id', id).gt('unread_count', 0).limit(1000),
  ]);
  const rows = recent.data ?? [];
  const cids = [...new Set(rows.map((r) => r.customer_id))];
  const { data: cs } = cids.length ? await db.from('customers').select('id,display_name,email').in('id', cids) : { data: [] };
  const name = (cid: string) => { const c = cs?.find((x) => x.id === cid); return c?.display_name || c?.email || '알 수 없음'; };
  const nChan = count(chans), nMem = (mems.data ?? []).length;
  const unreadSum = (unread.data ?? []).reduce((a, r) => a + (r.unread_count ?? 0), 0);
  const stats: [string, number, string, boolean][] = [['진행 중', count(open), '현재 응대 중인 대화', false], ['미배정', count(unassigned), '담당자가 없는 진행 중 대화', count(unassigned) > 0], ['대기 중', count(waiting), '고객 답변·승인 대기', false], ['안 읽은 메시지', unreadSum, '확인하지 않은 고객 메시지', unreadSum > 0]];
  const todo = [
    { done: nChan > 0, t: '채널 연결', d: '이메일 또는 웹 채팅 채널을 추가하세요.', href: `${base}/channels`, show: admin },
    { done: nMem > 1, t: '팀원 초대', d: '상담원을 초대해 함께 응대하세요.', href: `${base}/team`, show: admin },
    { done: rows.length > 0, t: '첫 대화 받기', d: '채널로 문의가 들어오면 Inbox에 나타납니다.', href: `${base}/inbox`, show: true },
  ].filter((x) => x.show);
  const pending = todo.filter((x) => !x.done);
  return (
    <>
      <PageHeader title="개요" desc="지금 응대가 필요한 문의를 한눈에 확인합니다." action={<LinkButton href={`${base}/inbox`}>Inbox 열기</LinkButton>} />
      <section aria-label="요약" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([l, n, d, hot]) => <StatCard key={l} label={l} value={n} desc={d} hot={hot} />)}
      </section>
      {pending.length > 0 && (
        <Section title="시작하기" desc={`${todo.length - pending.length}/${todo.length} 완료`} className="mt-4">
          <ul className="grid divide-y divide-[var(--border)] md:grid-cols-3 md:divide-x md:divide-y-0">{todo.map((x) => (
            <li key={x.t} className="flex gap-3 p-4">
              <span aria-hidden className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded border text-xs ${x.done ? 'border-[#0075de] bg-[#0075de] text-white' : 'border-black/30 bg-white'}`}>{x.done ? '✓' : ''}</span>
              <div><Link href={x.href} className="font-medium hover:underline">{x.t}</Link><span className="sr-only">{x.done ? ' (완료)' : ' (미완료)'}</span><p className="text-sm text-[#615d59]">{x.d}</p></div>
            </li>))}</ul>
        </Section>)}
      <Section title="최근 대화" className="mt-4" action={<Link href={`${base}/inbox`} className="text-sm font-medium text-[#0075de] hover:underline">전체 보기</Link>}>
        {rows.length ? <ul className="divide-y divide-[var(--border)]">{rows.map((r) => (
          <li key={r.id}>
            <Link href={`${base}/inbox`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-black/[.03]">
              <div className="min-w-0"><div className="truncate"><span className={r.unread_count ? 'font-semibold' : 'font-medium'}>{name(r.customer_id)}</span> <span className="text-[#615d59]">· {r.subject ?? '(제목 없음)'}</span></div><div className="truncate text-sm text-[#615d59]">{r.last_message_preview ?? ''}</div></div>
              <span className="flex shrink-0 items-center gap-2">{r.unread_count > 0 && <span className="rounded-full bg-[#0075de] px-2 py-0.5 text-xs font-medium text-white"><span className="sr-only">안 읽음 </span>{r.unread_count}</span>}<StatusPill status={r.status} label={STATUS_LABEL[r.status] ?? r.status} /></span>
            </Link>
          </li>))}</ul>
          : <EmptyState title="아직 대화가 없습니다" desc="채널을 연결하면 고객 문의가 여기에 모입니다." action={admin ? { href: `${base}/channels`, label: '채널 연결하기' } : undefined} />}
      </Section>
    </>
  );
}
