import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';

const Id = z.string().uuid();
const Body = z.object({ role: z.enum(['admin', 'agent', 'viewer']) });
// Authorization is enforced again inside the RPCs (role matrix in DATABASE §3); the org check here is defense in depth.
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'admin');
  unwrapDb(await c.db.rpc('set_member_role', { p_member: Id.parse(params.id), p_role: Body.parse(await req.json().catch(() => null)).role }));
  return { ok: true };
});
export const DELETE = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'admin');
  unwrapDb(await c.db.rpc('remove_member', { p_member: Id.parse(params.id) }));
  return { ok: true };
});
