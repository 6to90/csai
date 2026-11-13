import { z } from 'zod';
import { cleanText, preflight, requireChatSession, withCors } from '@/server/chat';
import { route, unwrapDb } from '@/server/http';
import { enforceRateLimit } from '@/server/security/ratelimit';
import { systemClient } from '@/server/security/system-client';
import { JSON_LIMIT, readJson } from '@/server/http-body';

export const OPTIONS = preflight;
const Body = z.object({ body: z.string().max(8000).transform(cleanText).pipe(z.string().trim().min(1).max(4000)), client_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict();

export const POST = withCors(route(async (req) => {
  const s = await requireChatSession(req);
  await Promise.all([enforceRateLimit(`chat:${s.id}:send`, 20, 60, { failClosed: true }), enforceRateLimit(`chat:${s.id}:day`, 500, 86400, { failClosed: true })]);
  const b = Body.parse(await readJson(req, JSON_LIMIT.chatMessage));
  // client_id is the dedupe key: retrying the same message (flaky network) returns the first one.
  const r = (unwrapDb(await systemClient().rpc('process_inbound', { p_org: s.org_id, p_channel: s.channel_account_id, p_msg: { external_id: `chat:${s.id}:${b.client_id}`, from_kind: s.verified_email ? 'email' : 'chat_visitor', from_value: s.verified_email ?? s.visitor_id, body: b.body, conversation_id: s.conversation_id } })) as { out_msg: string; out_dup: boolean }[])[0];
  return Response.json({ data: { id: r.out_msg, duplicate: r.out_dup } }, { status: r.out_dup ? 200 : 201 });
}));

// Polling feed (fallback for SSE). Visitors only ever see their own messages and SENT agent/AI/system replies: never notes or drafts.
export const GET = withCors(route(async (req) => {
  const s = await requireChatSession(req);
  await enforceRateLimit(`chat:${s.id}:poll`, 60, 60, { failClosed: true });
  const after = new URL(req.url).searchParams.get('after');
  let q = systemClient().from('messages').select('id,direction,body,created_at').eq('org_id', s.org_id).eq('conversation_id', s.conversation_id)
    .or('direction.eq.inbound,and(direction.eq.outbound,status.eq.sent,sender_type.in.(agent,ai,system))').order('created_at').limit(100);
  if (after && !Number.isNaN(Date.parse(after))) q = q.gte('created_at', after);   // >=: ties at the cursor are re-sent; the client dedupes by id
  return unwrapDb(await q);
}));
