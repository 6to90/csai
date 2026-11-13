'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field } from '@/components/ui/controls';

export function CreateOrg() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    const r = await fetch('/api/v1/orgs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.get('name'), slug: f.get('slug') }) });
    setBusy(false);
    if (r.ok) { router.refresh(); (e.target as HTMLFormElement).reset(); return; }
    const code = (await r.json().catch(() => null))?.error?.code;
    setErr(code === 'conflict' ? '이미 사용 중인 주소(slug)입니다.' : code === 'rate_limited' ? '잠시 후 다시 시도해 주세요.' : '조직을 만들 수 없습니다. 입력값을 확인해 주세요.');
  }
  return (
    <form onSubmit={onSubmit} className="card flex max-w-md flex-col gap-4 p-6">
      <h2 className="text-base font-semibold">조직 만들기</h2>
      <Field id="org-name" name="name" label="조직 이름" required maxLength={120} />
      <Field id="org-slug" name="slug" label="주소(slug) — 영문 소문자·숫자·하이픈" required pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" />
      <div aria-live="polite" className="min-h-5 text-sm text-[var(--danger)]">{err}</div>
      <Button type="submit" disabled={busy}>{busy ? '만드는 중…' : '만들기'}</Button>
    </form>
  );
}
