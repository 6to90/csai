'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createBrowser } from '@/lib/supabase/browser';
import { Button } from '@/components/ui/controls';
import { Skeleton, StatusPill } from '@/components/ui/data';

interface Conv { id: string; status: string; priority: string; assignee_id: string | null; subject: string | null; last_message_at: string | null; last_message_preview: string | null; unread_count: number; customer: { display_name: string | null; email: string | null } | null }
interface Msg { id: string; direction: string; body: string; status: string; error_code: string | null; created_at: string; attachments?: { id: string; filename: string; size: number }[] }
interface Detail extends Conv { chat?: { online: boolean; ended: boolean } | null; messages: Msg[]; channel: { kind: string; name: string } | null; customer: (Conv['customer'] & { phone?: string | null; tags?: string[] }) | null }
const STATUS: Record<string, string> = { open: '진행중', pending_approval: '승인 대기', waiting_customer: '고객 응답 대기', resolved: '해결됨', closed: '종료' };
const PRIORITY: Record<string, string> = { low: '낮음', normal: '보통', high: '높음', urgent: '긴급' };
const MSG_STATE: Record<string, string> = { queued: '발송 대기', sending: '발송 중', failed: '발송 실패', sent: '', received: '' };
const FAIL: Record<string, string> = {
  uncertain_delivery: '발송 결과가 불확실합니다. 고객이 이미 받았을 수 있어요. 확인 후 필요할 때만 다시 보내세요.',
  auth_failed: 'SMTP 인증에 실패했습니다. 채널의 SMTP 설정을 확인하세요.', tls_cert_invalid: 'SMTP 서버의 TLS 인증서를 신뢰할 수 없습니다.', no_transport: '발송 설정(SMTP)이 없습니다.',
  smtp_550: '받는 주소가 거부되었습니다(550).', no_recipient: '받는 이메일 주소가 없습니다.' };
const PRIO_DOT: Record<string, string> = { low: 'bg-[#a39e98]', normal: 'bg-[#d9d6d2]', high: 'bg-[#dd5b00]', urgent: 'bg-[#c4260f]' };
const sel = 'min-h-9 rounded-md border border-[var(--border-strong)] bg-white px-2 text-sm text-[var(--text-primary)]';

export function Inbox({ orgId, meId, canAct, members }: { orgId: string; meId: string; canAct: boolean; members: { id: string; email: string }[] }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [sel_, setSel] = useState<string | null>(null);
  const [detailRaw, setDetail] = useState<Detail | null>(null);
  const [f, setF] = useState({ status: '', assignee: '', q: '', unread: false });
  const [live, setLive] = useState<'connecting' | 'live' | 'down'>('connecting');
  const [err, setErr] = useState<string | null>(null);
  const [list, setList] = useState<'loading' | 'ok' | 'error'>('loading');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [detailErr, setDetailErr] = useState(false);
  const clientId = useRef<string>(crypto.randomUUID());   // reused until the send succeeds: a retry/double click cannot double-send
  const detail = detailRaw && detailRaw.id === sel_ ? detailRaw : null;   // never show the previous conversation while the next one loads
  const selRef = useRef<string | null>(null);

  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-org-id': orgId, ...(init.headers as object) } });
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
  }, [orgId]);

  const loadList = useCallback(async () => {
    const p = new URLSearchParams(); if (f.status) p.set('status', f.status); if (f.assignee) p.set('assignee', f.assignee); if (f.q.trim()) p.set('q', f.q.trim()); if (f.unread) p.set('unread', '1');
    const r = await api(`/api/v1/conversations?${p}`).catch(() => null); if (r?.ok) { setConvs(r.json.data); setList('ok'); } else setList('error');
  }, [api, f]);
  const loadDetail = useCallback((id: string) => api(`/api/v1/conversations/${id}`).then(
    (r) => { if (selRef.current !== id) return; if (r.ok) { setDetail(r.json.data); setDetailErr(false); } else setDetailErr(true); },   // never leave the pane on "loading" forever
    () => { if (selRef.current === id) setDetailErr(true); },
  ), [api]);
  useEffect(() => { const t = setTimeout(loadList, f.q ? 300 : 0); return () => clearTimeout(t); }, [loadList, f.q]);
  useEffect(() => { if (!sel_) return; void loadDetail(sel_); if (canAct) void api(`/api/v1/conversations/${sel_}/read`, { method: 'POST' }).then(loadList); }, [sel_]); // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime (user JWT => RLS applies). Any change just triggers a re-read; on (re)connect everything is re-read so nothing is missed while offline.
  const refresh = useRef<() => void>(() => {});
  useEffect(() => { selRef.current = sel_; refresh.current = () => { void loadList(); if (selRef.current) void loadDetail(selRef.current); }; });
  useEffect(() => {
    const sb = createBrowser(); let timer: ReturnType<typeof setTimeout> | undefined; let wasDown = false; let cancelled = false;
    let ch: ReturnType<typeof sb.channel> | undefined;
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => refresh.current(), 250); };
    // The socket must carry the USER's JWT before subscribing, otherwise Realtime evaluates RLS as anon and delivers nothing.
    void sb.auth.getSession().then(async ({ data }) => {
      if (cancelled) return;
      await sb.realtime.setAuth(data.session?.access_token ?? null);
      ch = sb.channel(`inbox:${orgId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `org_id=eq.${orgId}` }, bump)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `org_id=eq.${orgId}` }, bump)
        .subscribe((st) => { if (st === 'SUBSCRIBED') { setLive('live'); if (wasDown) refresh.current(); wasDown = false; } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') { setLive('down'); wasDown = true; } });
    });
    const poll = setInterval(() => { if (document.visibilityState === 'visible') refresh.current(); }, 30_000);   // safety net if a socket silently stalls
    return () => { cancelled = true; clearTimeout(timer); clearInterval(poll); if (ch) void sb.removeChannel(ch); };
  }, [orgId]);

  async function patch(body: object) {
    if (!sel_) return; setErr(null);
    const r = await api(`/api/v1/conversations/${sel_}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (!r.ok) setErr('변경하지 못했습니다. 권한이나 값을 확인해 주세요.'); await loadDetail(sel_); await loadList();
  }
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const body = String(new FormData(form).get('body') ?? '').trim();
    if (!sel_ || !body) return; setBusy(true); setErr(null);
    const r = await api(`/api/v1/conversations/${sel_}/messages`, { method: 'POST', body: JSON.stringify({ body, client_id: clientId.current, internal }) });
    setBusy(false);
    if (!r.ok) { setErr(r.status === 429 ? '잠시 후 다시 시도해 주세요.' : r.status === 422 ? '이 대화로는 답장을 보낼 수 없습니다. 받는 사람 정보가 없거나 종료된 대화일 수 있습니다. 내부 메모는 저장할 수 있습니다.' : '전송하지 못했습니다. 다시 눌러도 중복 전송되지 않습니다.'); return; }
    clientId.current = crypto.randomUUID(); form.reset(); await loadDetail(sel_); await loadList();
  }
  const name = (c: Conv) => c.customer?.display_name || c.customer?.email || '알 수 없음';
  const assigneeLabel = (id: string | null) => !id ? '미배정' : id === meId ? '나' : members.find((m) => m.id === id)?.email ?? '다른 담당자';

  const related = detail?.customer?.email ? convs.filter((c) => c.id !== detail.id && c.customer?.email === detail.customer?.email) : [];
  const customerBody = detail ? (<>
              <dl className="grid gap-2 text-sm">
                <div><dt className="text-xs text-[var(--text-muted)]">이름</dt><dd className="break-all">{detail.customer?.display_name ?? '-'}</dd></div>
                <div><dt className="text-xs text-[var(--text-muted)]">이메일</dt><dd className="break-all">{detail.customer?.email ?? '없음'}</dd></div>
                <div><dt className="text-xs text-[var(--text-muted)]">전화</dt><dd>{detail.customer?.phone ?? '없음'}</dd></div>
                <div><dt className="text-xs text-[var(--text-muted)]">채널</dt><dd>{detail.channel?.name} ({detail.channel?.kind === 'email' ? '이메일' : '웹 채팅'})</dd></div>
                <div><dt className="text-xs text-[var(--text-muted)]">담당</dt><dd>{assigneeLabel(detail.assignee_id)}</dd></div>
                {detail.customer?.tags?.length ? <div><dt className="text-xs text-[var(--text-muted)]">태그</dt><dd className="flex flex-wrap gap-1">{detail.customer.tags.map((t) => <span key={t} className="rounded bg-black/5 px-1.5 text-xs">{t}</span>)}</dd></div> : null}
              </dl>
              {related.length > 0 && <div><h3 className="text-xs font-semibold text-[var(--text-secondary)]">이 고객의 다른 대화 (불러온 목록 기준)</h3><ul className="mt-1 grid gap-1">{related.slice(0, 5).map((c) => <li key={c.id}><button type="button" className="w-full truncate text-left text-sm text-[#0075de] underline" onClick={() => setSel(c.id)}>{c.subject ?? '(제목 없음)'}</button></li>)}</ul></div>}
              <div className="rounded-md border border-dashed border-[var(--border-strong)] p-2 text-sm text-[var(--text-muted)]"><span className="font-medium text-[var(--text-secondary)]">주문 정보</span> <span className="ml-1 rounded bg-black/5 px-1.5 text-xs">개발 중</span><p className="mt-1 text-xs">외부 주문 시스템 연동 후 표시됩니다.</p></div>
  </>) : null;
  const liveDot = live === 'live' ? 'bg-[#1a7f37]' : live === 'down' ? 'bg-[#a65b00]' : 'bg-[#757575]';
  const filtered = !!(f.status || f.assignee || f.q.trim() || f.unread);
  return (
    <div className="flex flex-col gap-3">
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-[#615d59]"><span aria-hidden className={`size-2 rounded-full ${liveDot}`} />{live === 'live' ? '실시간 연결됨' : live === 'down' ? '연결이 끊겼습니다. 재연결 중이며 30초마다 새로고침합니다.' : '연결 중…'}</div>
      <div className={`grid gap-3 lg:h-[calc(100dvh-10rem)] lg:min-h-[520px] lg:grid-cols-[340px_minmax(0,1fr)] ${sel_ ? 'xl:grid-cols-[340px_minmax(0,1fr)_260px]' : ''}`}>
        <section aria-label="대화 목록" className={`${sel_ ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col gap-3`}>
          <div className="card flex flex-col gap-2 rounded-md p-2.5">
            <label className="sr-only" htmlFor="q">검색</label>
            <input id="q" type="search" placeholder="이름·이메일·제목 검색" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} className="min-h-9 rounded-md border border-[var(--border-strong)] bg-white px-3 text-sm placeholder:text-[var(--text-muted)]" />
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="상태 필터" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={sel}><option value="">모든 상태</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select aria-label="담당자 필터" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })} className={sel}><option value="">모든 담당자</option><option value="me">내 대화</option><option value="unassigned">미배정</option></select>
              <label className="flex min-h-9 items-center gap-1.5 text-sm text-[var(--text-secondary)]"><input type="checkbox" checked={f.unread} onChange={(e) => setF({ ...f, unread: e.target.checked })} />안 읽음</label>
              {filtered && <button type="button" className="text-sm text-[#0075de] underline" onClick={() => setF({ status: '', assignee: '', q: '', unread: false })}>초기화</button>}
            </div>
          </div>
          <ul className="card flex min-h-0 flex-1 flex-col divide-y divide-[var(--border)] overflow-y-auto rounded-md p-0">
            {convs.map((c) => (
              <li key={c.id} className="list-none">
                <button type="button" onClick={() => setSel(c.id)} aria-current={c.id === sel_ ? 'true' : undefined} className={`flex w-full gap-2 border-l-2 px-3 py-2 text-left ${c.id === sel_ ? 'border-l-[#0075de] bg-[#e6f3fe]' : 'border-l-transparent bg-white hover:bg-[#f6f5f4]'}`}>
                  <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${PRIO_DOT[c.priority] ?? PRIO_DOT.normal}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2"><span className={`truncate text-sm ${c.unread_count ? 'font-semibold' : 'font-medium'}`}>{name(c)}</span><span className="flex shrink-0 items-center gap-1.5"><span className="text-xs text-[#757575]">{c.last_message_at ? new Date(c.last_message_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : ''}</span>{c.unread_count > 0 && <span className="rounded bg-[#0075de] px-1.5 text-xs text-white" aria-label={`안 읽은 메시지 ${c.unread_count}개`}>{c.unread_count}</span>}</span></span>
                    <span className={`block truncate text-sm ${c.unread_count ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>{c.subject ?? '(제목 없음)'}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">{c.last_message_preview}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5"><StatusPill status={c.status} label={STATUS[c.status] ?? c.status} />{c.priority !== 'normal' && <span className="rounded bg-black/5 px-1.5 text-xs">{PRIORITY[c.priority]}</span>}<span className="text-xs text-[#615d59]">{assigneeLabel(c.assignee_id)}</span></span>
                  </span>
                </button>
              </li>))}
            {list === 'loading' && <li className="p-4 text-sm text-[var(--text-secondary)]" role="status">불러오는 중…</li>}
            {list === 'error' && <li role="alert" className="card p-4 text-sm text-[#8a1c0e]">대화 목록을 불러오지 못했습니다. <button type="button" className="underline" onClick={() => void loadList()}>다시 시도</button></li>}
            {list === 'ok' && !convs.length && <li className="p-6 text-center text-sm text-[var(--text-secondary)]">{filtered ? '조건에 맞는 대화가 없습니다.' : '아직 대화가 없습니다. 채널을 연결하면 문의가 여기에 모입니다.'}</li>}
          </ul>
        </section>

        <section aria-label="대화 상세" className={`${sel_ ? 'flex' : 'hidden lg:flex'} card min-h-0 min-w-0 flex-col gap-3 rounded-md p-4`}>
          {!detail ? (sel_
            ? (<div className="flex flex-1 flex-col gap-3">
                <Button variant="secondary" className="w-fit lg:hidden" onClick={() => setSel(null)}>← 목록</Button>
                {detailErr
                  ? <div role="alert" className="m-auto text-center text-sm text-[#8a1c0e]">대화를 불러오지 못했습니다. <button type="button" className="underline" onClick={() => void loadDetail(sel_)}>다시 시도</button></div>
                  : <p className="m-auto text-sm text-[var(--text-secondary)]" role="status">불러오는 중…</p>}
              </div>)
            : <div className="m-auto max-w-xs text-center"><p className="text-base font-semibold">대화를 선택하세요</p><p className="mt-1 text-sm text-[var(--text-secondary)]">목록에서 문의를 고르면 메시지와 답장 입력이 여기에 표시됩니다.</p></div>) : (<>
            <div className="flex items-center gap-2"><Button variant="secondary" className="lg:hidden" onClick={() => setSel(null)}>← 목록</Button><div className="min-w-0"><h2 className="truncate text-base font-semibold">{detail.subject ?? '(제목 없음)'}</h2><p className="truncate text-xs text-[var(--text-secondary)]">{name(detail)} · {detail.channel?.kind === 'email' ? '이메일' : '웹 채팅'}{detail.channel?.name ? ` · ${detail.channel.name}` : ''}</p></div></div>
            <div className="flex flex-wrap gap-2 border-y border-[var(--border)] py-2">
              <select aria-label="상태 변경" disabled={!canAct} value={detail.status} onChange={(e) => patch({ status: e.target.value })} className={sel}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select aria-label="우선순위 변경" disabled={!canAct} value={detail.priority} onChange={(e) => patch({ priority: e.target.value })} className={sel}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select aria-label="담당자 변경" disabled={!canAct} value={detail.assignee_id ?? ''} onChange={(e) => patch({ assignee_id: e.target.value || null })} className={sel}><option value="">미배정</option>{members.map((m) => <option key={m.id} value={m.id}>{m.id === meId ? `나 (${m.email})` : m.email}</option>)}</select>
            </div>
            {detail.chat && (
              <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]" role="status">
                <span>{detail.chat.ended ? '○ 방문자 연결 종료됨' : detail.chat.online ? '● 방문자 온라인' : '○ 방문자 오프라인'}</span>
                {canAct && !detail.chat.ended && (confirmEnd
                  ? <span className="flex flex-wrap items-center gap-2">방문자 연결을 끊고 대화를 종료할까요?
                      <Button variant="secondary" onClick={async () => { setConfirmEnd(false); await api(`/api/v1/conversations/${detail.id}/end-chat`, { method: 'POST' }); await loadDetail(detail.id); await loadList(); }}>종료 확인</Button>
                      <Button variant="secondary" onClick={() => setConfirmEnd(false)}>취소</Button></span>
                  : <Button variant="secondary" onClick={() => setConfirmEnd(true)}>채팅 종료</Button>)}
              </div>)}
            <details className="rounded-md border border-[var(--border)] xl:hidden"><summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-medium">고객 정보</summary><div className="grid gap-3 px-3 pb-3">{customerBody}</div></details>
            <ol aria-label="메시지" className="flex max-h-[60dvh] min-h-0 flex-1 flex-col gap-2 overflow-y-auto lg:max-h-none">
              {detail.messages.map((m) => (
                <li key={m.id} className={`max-w-[92%] list-none rounded-md border p-2.5 ${m.direction === 'inbound' ? 'self-start border-transparent bg-[#f6f5f4]' : m.direction === 'internal' ? 'self-end border-[#ffb110] bg-[#fff4d6]' : 'self-end border-transparent bg-[#e6f3fe]'}`}>
                  <div className="text-xs text-[var(--text-secondary)]">{m.direction === 'inbound' ? name(detail) : m.direction === 'internal' ? '내부 메모 (고객에게 보이지 않음)' : '상담원'} · {new Date(m.created_at).toLocaleString('ko-KR')}</div>
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  {m.attachments?.length ? <p className="text-sm text-[var(--text-secondary)]">첨부: {m.attachments.map((a) => a.filename).join(', ')}</p> : null}
                  {MSG_STATE[m.status] && <p className={`text-sm ${m.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'}`}>{m.status === 'failed' && m.error_code && FAIL[m.error_code] ? FAIL[m.error_code] : MSG_STATE[m.status]}{m.status === 'failed' && canAct && <> <button type="button" className="underline" onClick={async () => { await api(`/api/v1/messages/${m.id}/retry`, { method: 'POST' }); await loadDetail(detail.id); }}>{m.error_code === 'uncertain_delivery' ? '그래도 다시 보내기' : '다시 보내기'}</button></>}</p>}
                </li>))}
            </ol>
            {canAct && (
              <form onSubmit={send} className="flex flex-col gap-2">
                <label htmlFor="body" className="text-[var(--text-secondary)]">{internal ? '내부 메모' : '답장'}</label>
                <textarea id="body" name="body" required maxLength={20000} rows={3} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') e.currentTarget.form?.requestSubmit(); }} className="rounded-md border border-[var(--border-strong)] bg-white p-3 text-[var(--text-primary)]" />
                <p className="text-xs text-[var(--text-muted)]">Ctrl/⌘ + Enter로 전송</p>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex min-h-11 items-center gap-2 text-[var(--text-secondary)]"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />내부 메모로 저장</label>
                  <button type="button" disabled title="AI 답변 제안은 개발 중입니다" className="min-h-11 rounded-md border border-dashed border-[var(--border-strong)] px-3 text-sm text-[var(--text-muted)]">AI 답변 제안 <span className="ml-1 rounded bg-black/5 px-1.5 text-xs">개발 중</span></button>
                  <Button type="submit" disabled={busy}>{busy ? '전송 중…' : internal ? '메모 저장' : '전송'}</Button>
                </div>
              </form>)}
            <div aria-live="polite" className="text-sm text-[var(--danger)]">{err}</div>
          </>)}
        </section>

        {sel_ && (
          <aside aria-label="고객 정보" className="card hidden min-h-0 flex-col gap-3 overflow-y-auto rounded-md p-4 xl:flex">
            <h2 className="text-base font-semibold">고객</h2>
            {detail ? (<>
              {customerBody}
            </>) : <><Skeleton className="h-5 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></>}
          </aside>)}
      </div>
    </div>
  );
}
