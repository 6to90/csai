import { notFound } from 'next/navigation';
import { z } from 'zod';
import { createCookieClient } from '@/lib/supabase/server';

/** Shared page prologue: validates the id, loads the caller's membership under RLS (foreign org => 404). */
export async function orgCtx(params: Promise<{ id: string }>) {
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const db = await createCookieClient();
  const { data: u } = await db.auth.getUser();
  // Owners/admins can read every membership of the org under RLS, so pin the row to the caller.
  const { data: me } = u.user ? await db.from('memberships').select('role,user_id').eq('org_id', id.data).eq('user_id', u.user.id).maybeSingle() : { data: null };
  if (!me) notFound();
  return { db, id: id.data, me, admin: me.role === 'owner' || me.role === 'admin', base: `/dashboard/orgs/${id.data}` };
}
export const ROLE_LABEL: Record<string, string> = { owner: '소유자', admin: '관리자', agent: '상담원', viewer: '조회자' };
export const STATUS_LABEL: Record<string, string> = { open: '진행 중', pending_approval: '승인 대기', waiting_customer: '고객 답변 대기', resolved: '해결됨', closed: '종료' };
