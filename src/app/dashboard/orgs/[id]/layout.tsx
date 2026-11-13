import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { createCookieClient } from '@/lib/supabase/server';
import { DashNav, type NavGroup } from './DashNav';
import { SignOut } from '../../SignOut';

const ROLE_LABEL: Record<string, string> = { owner: '소유자', admin: '관리자', agent: '상담원', viewer: '조회자' };

// App shell. Membership is read under RLS with the user's own session: a foreign/unknown org id yields 404, never data.
export default async function OrgLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const db = await createCookieClient();
  const { data: u } = await db.auth.getUser();
  const [{ data: me }, { data: org }] = await Promise.all([
    db.from('memberships').select('role').eq('org_id', id.data).eq('user_id', u.user?.id ?? '').maybeSingle(),   // owners see all rows under RLS: pin to self
    db.from('organizations').select('id,name').eq('id', id.data).maybeSingle(),
  ]);
  if (!me || !org) notFound();
  const b = `/dashboard/orgs/${org.id}`;
  const [{ data: unread }, { count: orgCount }] = await Promise.all([
    db.from('conversations').select('unread_count').eq('org_id', org.id).gt('unread_count', 0).limit(1000),
    db.from('memberships').select('id', { count: 'exact', head: true }).eq('user_id', u.user?.id ?? ''),
  ]);
  const unreadTotal = (unread ?? []).reduce((a, r) => a + (r.unread_count ?? 0), 0);
  const groups: NavGroup[] = [
    { label: '업무', items: [{ href: b, label: '개요', icon: 'home' }, { href: `${b}/inbox`, label: '통합 Inbox', icon: 'inbox', badge: unreadTotal }, { href: `${b}/customers`, label: '고객', icon: 'contact' }] },
    { label: 'AI 자동화', items: [{ href: `${b}/agents`, label: 'AI 에이전트', icon: 'bot', soon: true }, { href: `${b}/knowledge`, label: '지식 베이스', icon: 'book', soon: true }, { href: `${b}/workflows`, label: '워크플로', icon: 'flow', soon: true }] },
    { label: '운영', items: [{ href: `${b}/analytics`, label: '분석', icon: 'chart' }, { href: `${b}/channels`, label: '채널·연동', icon: 'plug' }] },
    { label: '관리', items: [{ href: `${b}/team`, label: '팀 관리', icon: 'users' }, { href: `${b}/billing`, label: '결제·구독', icon: 'card' }, { href: `${b}/settings`, label: '설정', icon: 'sliders' }] },
  ];
  return <DashNav groups={groups} orgName={org.name} role={ROLE_LABEL[me.role]} email={u.user?.email ?? ''} switchable={(orgCount ?? 0) > 1} footer={<SignOut />}>{children}</DashNav>;
}
