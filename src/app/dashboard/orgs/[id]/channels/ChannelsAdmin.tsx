'use client';
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field } from '@/components/ui/controls';
import { EmptyState, Section, StatusPill } from '@/components/ui/data';

export interface Channel { id: string; kind: string; name: string; address: string | null; status: string; public_key: string | null; config: { allowed_origins?: string[]; title?: string; greeting?: string; color?: string; from_name?: string } }
const noop = () => () => {};
const useOrigin = () => useSyncExternalStore(noop, () => location.origin, () => '');   // '' on the server, real origin after hydration
const snippet = (origin: string, key: string) => `<script src="${origin}/widget.js" data-key="${key}" async></script>`;
const origins = (v: string) => v.split(/[\s,]+/).filter(Boolean);

export function ChannelsAdmin({ orgId, channels }: { orgId: string; channels: Channel[] }) {
  const router = useRouter();
  const origin = useOrigin();
  const [kind, setKind] = useState<'email' | 'web_chat'>('email');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [once, setOnce] = useState<{ title: string; lines: { k: string; v: string }[] } | null>(null);   // secrets are shown a single time, never fetched again
  const [edit, setEdit] = useState<string | null>(null);
  const call = (method: string, path: string, body?: unknown) => fetch(path, { method, headers: { 'content-type': 'application/json', 'x-org-id': orgId }, body: body ? JSON.stringify(body) : undefined });

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); setBusy(true); setMsg(null); setOnce(null);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const body = kind === 'email'
      ? { kind, name: s('name'), address: s('address'), ...(s('from_name') ? { from_name: s('from_name') } : {}), ...(s('smtp_url') ? { smtp_url: s('smtp_url') } : {}) }
      : { kind, name: s('name'), allowed_origins: origins(s('origins')), ...(s('title') ? { title: s('title') } : {}), ...(s('greeting') ? { greeting: s('greeting') } : {}), ...(s('color') ? { color: s('color') } : {}) };
    const r = await call('POST', '/api/v1/channels', body); setBusy(false); const j = await r.json().catch(() => null);
    if (!r.ok) { setMsg({ ok: false, text: '채널을 만들지 못했습니다. 입력값을 확인해 주세요 (허용 출처는 https://도메인 형식, 색은 #RRGGBB).' }); return; }
    form.reset(); router.refresh();
    if (j.data.webhook_secret) setOnce({ title: '웹훅 서명 비밀은 지금 한 번만 표시됩니다. 안전한 곳에 복사하세요.', lines: [{ k: '수신 URL', v: `${origin}${j.data.webhook_path}` }, { k: '서명 비밀', v: j.data.webhook_secret }] });
    if (j.data.identity_secret) setOnce({ title: 'ID 검증 비밀은 지금 한 번만 표시됩니다. 고객사 서버에만 보관하세요(브라우저·스크립트에 넣지 마세요).', lines: [{ k: '설치 스니펫', v: snippet(origin, j.data.public_key) }, { k: 'ID 검증 비밀', v: j.data.identity_secret }] });
    setMsg({ ok: true, text: '채널을 만들었습니다.' });
  }
  async function toggle(c: Channel) { const r = await call('PATCH', `/api/v1/channels/${c.id}`, { status: c.status === 'active' ? 'paused' : 'active' }); if (r.ok) router.refresh(); }
  async function save(e: FormEvent<HTMLFormElement>, c: Channel) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const s = (k: string) => String(f.get(k) ?? '').trim(); setBusy(true); setMsg(null);
    const r = await call('PATCH', `/api/v1/channels/${c.id}`, { name: s('name'), widget: { allowed_origins: origins(s('origins')), title: s('title'), greeting: s('greeting'), ...(s('color') ? { color: s('color') } : {}) } });
    setBusy(false); setMsg(r.ok ? { ok: true, text: '위젯 설정을 저장했습니다. 제거한 출처의 기존 세션은 다음 요청에서 종료됩니다.' } : { ok: false, text: '저장하지 못했습니다. 입력값을 확인해 주세요.' }); if (r.ok) { setEdit(null); router.refresh(); }
  }
  async function rotate(c: Channel) {
    setMsg(null); const r = await call('POST', `/api/v1/channels/${c.id}/rotate-secret`); const j = await r.json().catch(() => null);
    if (!r.ok) { setMsg({ ok: false, text: '재발급하지 못했습니다.' }); return; }
    setOnce({ title: '새 ID 검증 비밀입니다(이전 비밀은 즉시 무효). 한 번만 표시됩니다.', lines: [{ k: 'ID 검증 비밀', v: j.data.identity_secret }] });
  }

  const alerts = (<>
    <div aria-live="polite">{msg && <p className={`rounded-lg px-4 py-2 text-sm ${msg.ok ? 'bg-[#dff3e4] text-[#14532d]' : 'bg-[#fde2de] text-[#8a1c0e]'}`}>{msg.text}</p>}</div>
    {once && (
      <div role="alert" className="flex flex-col gap-1 rounded-xl border border-[#ffb110] bg-[#fff4d6] p-4 text-sm">
        <p className="font-semibold">{once.title}</p>
        {once.lines.map((l) => <p key={l.k} className="text-[var(--text-secondary)]">{l.k}: <code className="break-all text-black">{l.v}</code></p>)}
      </div>)}
  </>);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
      <div className="flex flex-col gap-4">
        {alerts}
        <ul className="flex flex-col gap-3">
          {channels.map((c) => (
            <li key={c.id} className="card flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0"><div className="flex items-center gap-2"><strong className="break-all">{c.name}</strong><StatusPill status={c.status} label={c.status === 'active' ? '사용 중' : c.status === 'paused' ? '일시중지' : '오류'} /></div>
                  <div className="text-sm text-[var(--text-secondary)]">{c.kind === 'email' ? `이메일 · ${c.address}` : '웹 채팅 위젯'}</div></div>
                <span className="flex gap-2">
                  {c.kind === 'web_chat' && <Button variant="secondary" className="min-h-9" onClick={() => setEdit(edit === c.id ? null : c.id)} aria-expanded={edit === c.id}>설정</Button>}
                  <Button variant="secondary" className="min-h-9" onClick={() => toggle(c)}>{c.status === 'active' ? '일시중지' : '다시 사용'}</Button>
                </span>
              </div>
              {c.kind === 'web_chat' && c.public_key && (
                <div className="text-sm text-[var(--text-secondary)]">
                  <p>설치 스니펫 (웹사이트 <code>&lt;body&gt;</code> 끝에 붙여넣기):</p>
                  <code className="mt-1 block break-all rounded-lg bg-[#f6f5f4] p-2 text-xs text-black">{snippet(origin, c.public_key)}</code>
                  <p className="mt-1">허용 출처: {(c.config.allowed_origins ?? []).join(', ') || '없음'}</p>
                </div>)}
              {c.kind === 'web_chat' && edit === c.id && (
                <form onSubmit={(e) => save(e, c)} className="flex max-w-md flex-col gap-3 border-t border-[var(--border)] pt-3">
                  <Field id={`n-${c.id}`} name="name" label="이름" defaultValue={c.name} required maxLength={120} />
                  <Field id={`o-${c.id}`} name="origins" label="허용 출처 (공백·쉼표 구분)" defaultValue={(c.config.allowed_origins ?? []).join(' ')} required />
                  <Field id={`t-${c.id}`} name="title" label="위젯 제목 (최대 40자)" defaultValue={c.config.title ?? ''} maxLength={40} />
                  <Field id={`g-${c.id}`} name="greeting" label="첫 인사말 (최대 200자)" defaultValue={c.config.greeting ?? ''} maxLength={200} />
                  <Field id={`c-${c.id}`} name="color" label="강조 색 (#RRGGBB)" defaultValue={c.config.color ?? ''} pattern="#[0-9a-fA-F]{6}" />
                  <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{busy ? '저장 중…' : '저장'}</Button><Button type="button" variant="secondary" onClick={() => rotate(c)}>ID 검증 비밀 재발급</Button></div>
                </form>)}
            </li>))}
          {!channels.length && <li className="card"><EmptyState title="연결된 채널이 없습니다" desc="오른쪽 양식에서 이메일 또는 웹 채팅 위젯을 추가하세요." /></li>}
        </ul>
      </div>
      <Section title="채널 추가" desc="이메일 주소 또는 웹 채팅 위젯을 연결합니다." className="xl:sticky xl:top-16">
      <form onSubmit={create} className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1"><label htmlFor="kind" className="text-[var(--text-secondary)]">종류</label>
          <select id="kind" value={kind} onChange={(e) => setKind(e.target.value as 'email' | 'web_chat')} className="min-h-11 rounded-lg border border-[var(--border-strong)] bg-white px-3 text-[var(--text-primary)]"><option value="email">이메일</option><option value="web_chat">웹 채팅 위젯</option></select></div>
        <Field id="ch-name" name="name" label="이름" required maxLength={120} />
        {kind === 'email' ? (<>
          <Field id="ch-addr" name="address" type="email" label="지원 이메일 주소(발신 주소)" required />
          <Field id="ch-from" name="from_name" label="발신자 표시 이름 (선택)" maxLength={100} />
          <Field id="ch-smtp" name="smtp_url" label="SMTP URL (선택, 암호화 저장·재조회 불가)" placeholder="smtps://user:pass@host:465" autoComplete="off" />
        </>) : (<>
          <Field id="ch-origins" name="origins" label="허용 출처 (공백·쉼표 구분)" placeholder="https://shop.example" required />
          <Field id="ch-title" name="title" label="위젯 제목 (선택)" maxLength={40} />
          <Field id="ch-greeting" name="greeting" label="첫 인사말 (선택)" maxLength={200} />
          <Field id="ch-color" name="color" label="강조 색 #RRGGBB (선택)" pattern="#[0-9a-fA-F]{6}" />
        </>)}
        <Button type="submit" disabled={busy}>{busy ? '추가 중…' : '채널 추가'}</Button>
      </form>
      </Section>
    </div>
  );
}
