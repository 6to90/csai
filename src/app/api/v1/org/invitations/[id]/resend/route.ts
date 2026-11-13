import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';
import { enforceRateLimit } from '@/server/security/ratelimit';
import { deliverInvitation } from '@/server/invitations';

export const POST = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'admin');
  await enforceRateLimit(`org:${c.orgId}:invite`, 20, 3600, { failClosed: false });
  const id = z.string().uuid().parse(params.id);
  const rows = unwrapDb(await c.db.rpc('resend_invitation', { p_id: id })) as { inv_token: string; inv_expires_at: string }[];
  const email = (unwrapDb(await c.db.from('invitations').select('email').eq('id', id).eq('org_id', c.orgId).single()) as { email: string }).email;
  return Response.json({ data: { expires_at: rows[0].inv_expires_at, ...(await deliverInvitation(c.db, c.orgId, email, rows[0].inv_token, rows[0].inv_expires_at)) } }, { headers: { 'cache-control': 'no-store' } });
});
