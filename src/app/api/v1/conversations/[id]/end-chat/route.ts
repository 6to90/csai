import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';

// Agent ends a web chat: visitor tokens are revoked at once (their stream receives `closed`) and the conversation is closed.
export const POST = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'agent');
  const id = z.string().uuid().parse(params.id);
  const { data: own } = await c.db.from('conversations').select('id').eq('id', id).eq('org_id', c.orgId).maybeSingle();
  if (!own) throw new HttpError(404, 'not_found');
  return { revoked: unwrapDb(await c.db.rpc('end_chat', { p_conv: id })) };
});
