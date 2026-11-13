import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';
import { systemClient } from '@/server/security/system-client';

const Id = z.string().uuid();
export const GET = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'viewer');
  const id = Id.parse(params.id);
  const { data: conv, error } = await c.db.from('conversations').select('id,status,priority,assignee_id,subject,last_message_at,unread_count,channel_account_id,customer_id,created_at,customer:customers(id,display_name,email,phone,tags),channel:channel_accounts(kind,name)').eq('id', id).eq('org_id', c.orgId).maybeSingle();
  if (error) throw new HttpError(500, 'internal');
  if (!conv) throw new HttpError(404, 'not_found');
  const messages = unwrapDb(await c.db.from('messages').select('id,direction,sender_type,sender_id,content_type,body,status,error_code,created_at,attachments(id,filename,mime,size)').eq('org_id', c.orgId).eq('conversation_id', id).order('created_at').limit(500));
  // Web chat presence (chat_sessions is service-only): online = a live session seen within the last 60 s.
  let chat: { online: boolean; ended: boolean } | null = null;
  if ((conv.channel as { kind?: string } | null)?.kind === 'web_chat') {
    const { data: ss } = await systemClient().from('chat_sessions').select('last_seen_at,revoked_at,expires_at').eq('org_id', c.orgId).eq('conversation_id', id);
    const now = Date.now(); const live = (ss ?? []).filter((x) => !x.revoked_at && new Date(x.expires_at).getTime() > now);
    chat = { online: live.some((x) => now - new Date(x.last_seen_at).getTime() < 60_000), ended: live.length === 0 };
  }
  return { ...conv, chat, messages };
});

const Patch = z.object({ status: z.enum(['open', 'pending_approval', 'waiting_customer', 'resolved', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assignee_id: z.string().uuid().nullable().optional() })
  .strict().refine((b) => Object.keys(b).length > 0, 'no fields');
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'agent');
  const id = Id.parse(params.id);
  const { data: own } = await c.db.from('conversations').select('id').eq('id', id).eq('org_id', c.orgId).maybeSingle();   // the header org must own the conversation
  if (!own) throw new HttpError(404, 'not_found');
  unwrapDb(await c.db.rpc('update_conversation', { p_id: id, p_patch: Patch.parse(await req.json().catch(() => null)) }));
  return { ok: true };
});
