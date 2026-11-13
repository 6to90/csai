import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';

export const POST = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'admin');
  unwrapDb(await c.db.rpc('revoke_invitation', { p_id: z.string().uuid().parse(params.id) }));
  return { ok: true };
});
