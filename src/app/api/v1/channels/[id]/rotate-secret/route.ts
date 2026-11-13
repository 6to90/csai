import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';
import { enforceRateLimit } from '@/server/security/ratelimit';
import { secrets } from '@/server/security/secrets-instance';

// Issues a NEW identity-verification secret for a widget (the old one stops working immediately). Shown once, never readable again.
export const POST = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'admin');
  await enforceRateLimit(`org:${c.orgId}:secret_rotate`, 10, 3600, { failClosed: false });
  const id = z.string().uuid().parse(params.id);
  const { data: own } = await c.db.from('channel_accounts').select('id,kind').eq('id', id).eq('org_id', c.orgId).maybeSingle();
  if (!own || own.kind !== 'web_chat') throw new HttpError(404, 'not_found');
  const integ = unwrapDb(await c.db.rpc('prepare_widget_secret', { p_id: id })) as string;     // audited
  const identity = randomBytes(32).toString('hex');
  await secrets().put(c.orgId, integ, 'identity_secret', identity);
  return Response.json({ data: { identity_secret: identity } }, { headers: { 'cache-control': 'no-store' } });
});
