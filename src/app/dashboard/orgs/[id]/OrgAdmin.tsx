'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field } from '@/components/ui/controls';
import { DataTable, EmptyState, Section, StatusPill, type Col } from '@/components/ui/data';
import { Modal } from '@/components/ui/modal';

export interface Member { id: string; userId: string; email: string; role: string }
export interface Invitation { id: string; email: string; role: string; status: string; expires_at: string }
const ROLE: Record<string, string> = { owner: '소유자', admin: '관리자', agent: '상담원', viewer: '조회자' };
const STATUS: Record<string, string> = { pending: '대기 중', accepted: '수락됨', revoked: '취소됨', expired: '만료됨' };
const ERR: Record<string, string> = { conflict: '이미 구성원이거나 대기 중인 초대가 있습니다.', rate_limited: '잠시 후 다시 시도해 주세요.', forbidden: '권한이 없습니다.' };

export function OrgAdmin({ part, orgId, orgName, role, meId, members, invitations }: { part: 'team' | 'settings'; orgId: string; orgName: string; role: string; meId: string; members: Member[]; invitations: Invitation[] }) {
  const router = useRouter();
  const admin = role === 'owner' || role === 'admin';
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);   // shown once, only when no mail transport is configured
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<Member | null>(null);   // member pending removal (confirm modal)

  async function call(method: string, path: string, body?: unknown) {
    setBusy(true); setMsg(null); setLink(null);
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-org-id': orgId }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    setBusy(false);
    if (!r) { setMsg({ ok: false, text: '네트워크 오류입니다. 연결을 확인하고 다시 시도해 주세요.' }); return null; }
    const j = await r.json().catch(() => null);
    if (!r.ok) { setMsg({ ok: false, text: ERR[j?.error?.code] ?? '처리하지 못했습니다. 입력값을 확인해 주세요.' }); return null; }
    router.refresh();
    return j?.data ?? {};
  }
  function afterInvite(d: { accept_url?: string } | null, what: string) {
    if (!d) return;
    if (d.accept_url) { setLink(d.accept_url); setMsg({ ok: true, text: `${what} 메일 발송이 설정되지 않아 링크를 직접 전달해 주세요(이 화면에서만 표시).` }); }
    else setMsg({ ok: true, text: `${what} 초대 메일을 보냈습니다.` });
  }
  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form);
    const d = await call('POST', '/api/v1/org/invitations', { email: f.get('email'), role: f.get('role') });
    if (d) { form.reset(); afterInvite(d, '초대를 만들었습니다.'); }
  }
  async function onRename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (await call('PATCH', '/api/v1/org', { name: new FormData(e.currentTarget).get('name') })) setMsg({ ok: true, text: '조직 이름을 저장했습니다.' });
  }
  async function setRole(m: Member, r: string) { if (await call('PATCH', `/api/v1/org/members/${m.id}`, { role: r })) setMsg({ ok: true, text: `${m.email}의 역할을 ${ROLE[r]}(으)로 변경했습니다.` }); }
  async function remove(m: Member) { const ok = await call('DELETE', `/api/v1/org/members/${m.id}`); setTarget(null); if (ok) setMsg({ ok: true, text: `${m.email}을(를) 조직에서 제거했습니다.` }); }

  const status = (
    <div aria-live="polite">
      {msg && <p className={`rounded-lg px-4 py-2 text-sm ${msg.ok ? 'bg-[#dff3e4] text-[#14532d]' : 'bg-[#fde2de] text-[#8a1c0e]'}`}>{msg.text}{link && <code className="mt-1 block break-all text-black">{link}</code>}</p>}
    </div>
  );
  const sel = 'min-h-9 rounded-lg border border-[var(--border-strong)] bg-white px-2 text-sm';

  const isLocked = (m: Member) => m.role === 'owner' || m.userId === meId || (role === 'admin' && m.role === 'admin');   // server re-checks every rule
  const cols: Col<Member>[] = [
    { key: 'email', header: '이메일', cell: (m) => <span className="break-all">{m.email}{m.userId === meId && <span className="ml-2 text-xs font-normal text-[#615d59]">(나)</span>}</span> },
    { key: 'role', header: '역할', cell: (m) => (admin && !isLocked(m) ? (
      <select aria-label={`${m.email} 역할`} value={m.role} disabled={busy} onChange={(e) => setRole(m, e.target.value)} className={sel}>
        {role === 'owner' && <option value="admin">관리자</option>}<option value="agent">상담원</option><option value="viewer">조회자</option>
      </select>) : <span className="text-black">{ROLE[m.role]}</span>) },
    ...(admin ? [{ key: 'act', header: '관리', align: 'right' as const, srOnlyHeader: true, cell: (m: Member) => (isLocked(m) ? null : <Button variant="secondary" className="min-h-9" disabled={busy} onClick={() => setTarget(m)}>제거</Button>) }] : []),
  ];
  const invCols: Col<Invitation>[] = [
    { key: 'email', header: '이메일', cell: (i) => <span className="break-all">{i.email}</span> },
    { key: 'role', header: '역할', cell: (i) => <span className="text-black">{ROLE[i.role]}</span> },
    { key: 'status', header: '상태', cell: (i) => <StatusPill status={i.status} label={STATUS[i.status] ?? i.status} /> },
    { key: 'exp', header: '만료', cell: (i) => (i.status === 'pending' ? `${i.expires_at.slice(0, 10)}까지` : '—') },
    { key: 'act', header: '관리', align: 'right', srOnlyHeader: true, cell: (i) => (
      <span className="inline-flex flex-wrap justify-end gap-2">
        {(i.status === 'pending' || i.status === 'expired') && <Button variant="secondary" className="min-h-9" disabled={busy} onClick={async () => afterInvite(await call('POST', `/api/v1/org/invitations/${i.id}/resend`), '재발송했습니다.')}>재발송</Button>}
        {i.status === 'pending' && <Button variant="secondary" className="min-h-9" disabled={busy} onClick={() => call('POST', `/api/v1/org/invitations/${i.id}/revoke`)}>취소</Button>}
      </span>) },
  ];
  if (part === 'settings') {
    return admin ? (
      <Section title="조직 이름" desc="대시보드에 표시되는 조직 이름입니다.">
        <form onSubmit={onRename} className="flex max-w-md flex-col gap-4 p-5">
          <Field id="org-name" name="name" label="조직 이름" defaultValue={orgName} required maxLength={120} />
          {status}
          <Button type="submit" disabled={busy} className="w-fit">{busy ? '저장 중…' : '저장'}</Button>
        </form>
      </Section>) : null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {status}
      <Modal open={!!target} onClose={() => setTarget(null)} title="멤버를 제거할까요?" confirmLabel="제거" busy={busy} onConfirm={() => target && remove(target)}>
        <strong className="break-all font-medium text-black">{target?.email}</strong>이(가) 이 조직에 더 이상 접근할 수 없게 됩니다.
      </Modal>
      <Section title={`멤버 ${members.length}명`}>
        <DataTable
          caption="멤버 목록" rows={members} rowKey={(m) => m.id} columns={cols}
        />
        {!admin && <p className="border-t border-[var(--border)] px-5 py-3 text-xs text-[#615d59]">멤버 초대·관리는 소유자·관리자만 할 수 있습니다.</p>}
      </Section>
      {admin && (<>
        <Section title="멤버 초대">
          <form onSubmit={onInvite} className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_160px_auto] lg:items-end">
            <Field id="inv-email" name="email" type="email" label="이메일" required maxLength={254} />
            <div className="flex flex-col gap-1">
              <label htmlFor="inv-role" className="text-sm font-medium text-[var(--text-secondary)]">역할</label>
              <select id="inv-role" name="role" defaultValue="agent" className="min-h-11 rounded-lg border border-[var(--border-strong)] bg-white px-3">
                {role === 'owner' && <option value="admin">관리자</option>}<option value="agent">상담원</option><option value="viewer">조회자</option>
              </select>
            </div>
            <Button type="submit" disabled={busy}>{busy ? '보내는 중…' : '초대 보내기'}</Button>
          </form>
        </Section>
        <Section title="보낸 초대">
          <DataTable
            caption="보낸 초대 목록" rows={invitations} rowKey={(i) => i.id} columns={invCols}
            empty={<EmptyState title="보낸 초대가 없습니다" desc="이메일과 역할을 입력해 팀원을 초대하세요." />}
          />
        </Section>
      </>)}
    </div>
  );
}
