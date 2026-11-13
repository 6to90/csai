import Link from 'next/link';
import { orgCtx } from '@/lib/org-page';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/controls';
import { DataTable, EmptyState, Section } from '@/components/ui/data';

const LIMIT = 100;

export default async function CustomersPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string }> }) {
  const { db, id, base } = await orgCtx(params);
  const q = ((await searchParams).q ?? '').trim().slice(0, 80).replace(/[%,()*\\]/g, '');   // strip PostgREST filter syntax chars
  let query = db.from('customers').select('id,display_name,email,phone,tags,created_at', { count: 'exact' }).eq('org_id', id).order('created_at', { ascending: false }).limit(LIMIT);
  if (q) query = query.or(`display_name.ilike.%${q}%,email.ilike.%${q}%`);
  const { data: cs, count } = await query;
  const ids = (cs ?? []).map((c) => c.id);
  const { data: convs } = ids.length ? await db.from('conversations').select('customer_id,last_message_at').eq('org_id', id).in('customer_id', ids).limit(2000) : { data: [] };
  const stat = (cid: string) => { const l = (convs ?? []).filter((c) => c.customer_id === cid); return { n: l.length, last: l.map((c) => c.last_message_at ?? '').sort().pop() || null }; };
  return (
    <>
      <PageHeader title="고객" desc="문의를 남긴 고객이 채널을 통해 자동으로 등록됩니다." />
      <Section title={q ? `검색 결과 ${count ?? 0}명` : `전체 고객 ${count ?? 0}명`} action={
        <form role="search" className="flex gap-2">
          <label htmlFor="q" className="sr-only">고객 검색</label>
          <input id="q" name="q" type="search" defaultValue={q} placeholder="이름 또는 이메일" className="min-h-9 w-44 rounded-lg border border-[var(--border-strong)] bg-white px-3 text-sm sm:w-64" />
          <Button type="submit" variant="ghost" className="min-h-9">검색</Button>
          {q && <Link href={`${base}/customers`} className="inline-flex min-h-9 items-center px-2 text-sm text-[#615d59] underline">초기화</Link>}
        </form>}>
        <DataTable
          caption="고객 목록" rows={cs ?? []} rowKey={(c) => c.id}
          columns={[
            { key: 'name', header: '고객', cell: (c) => c.display_name || <span className="font-normal text-[#757575]">(이름 없음)</span> },
            { key: 'contact', header: '연락처', cell: (c) => <span className="break-all">{c.email ?? c.phone ?? '—'}</span> },
            { key: 'n', header: '대화', align: 'right', cell: (c) => stat(c.id).n },
            { key: 'last', header: '최근 문의', cell: (c) => stat(c.id).last?.slice(0, 10) ?? '—' },
            { key: 'created', header: '등록일', hideOnMobile: true, cell: (c) => c.created_at.slice(0, 10) },
          ]}
          empty={<EmptyState title={q ? '검색 결과가 없습니다' : '아직 고객이 없습니다'} desc={q ? '다른 이름이나 이메일로 검색해 보세요.' : '채널로 문의가 들어오면 고객이 자동으로 추가됩니다.'} action={q ? undefined : { href: `${base}/channels`, label: '채널 연결하기' }} />}
        />
        {(count ?? 0) > LIMIT && <p className="border-t border-[var(--border)] px-5 py-3 text-xs text-[#615d59]">최근 {LIMIT}명만 표시합니다. 검색으로 좁혀 보세요.</p>}
      </Section>
    </>
  );
}
