import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';
import { enforceRateLimit } from '@/server/security/ratelimit';
import { JSON_LIMIT, readJson } from '@/server/http-body';

const Body = z.object({ body: z.string().trim().min(1).max(20000), client_id: z.string().uuid(), internal: z.boolean().optional() }).strict();
// client_id makes a double click / client retry return the existing message (200) instead of sending twice.
export const POST = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'agent');
  await enforceRateLimit(`user:${c.userId}:send`, 60, 60, { failClosed: false });
  const id = z.string().uuid().parse(params.id);
  const { data: own } = await c.db.from('conversations').select('id').eq('id', id).eq('org_id', c.orgId).maybeSingle();
  if (!own) throw new HttpError(404, 'not_found');
  const b = Body.parse(await readJson(req, JSON_LIMIT.agentMessage));
  const r = (unwrapDb(await c.db.rpc('send_reply', { p_conv: id, p_body: b.body, p_client_id: b.client_id, p_internal: b.internal ?? false })) as { out_msg: string; out_status: string; out_dup: boolean }[])[0];
  return Response.json({ data: { id: r.out_msg, status: r.out_status, duplicate: r.out_dup } }, { status: r.out_dup ? 200 : 201 });
});
