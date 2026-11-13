import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';

export const POST = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'agent');
  const id = z.string().uuid().parse(params.id);
  const { data: own } = await c.db.from('messages').select('id').eq('id', id).eq('org_id', c.orgId).maybeSingle();
  if (!own) throw new HttpError(404, 'not_found');
  unwrapDb(await c.db.rpc('retry_message', { p_msg: id }));
  return { ok: true };
});
