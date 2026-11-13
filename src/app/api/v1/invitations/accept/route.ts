import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireUser } from '@/server/security/authz';
import { enforceRateLimit, ipKey } from '@/server/security/ratelimit';
import { JSON_LIMIT, readJson } from '@/server/http-body';

const Body = z.object({ token: z.string().min(20).max(200) });
export const POST = route(async (req) => {
  const u = await requireUser(req);
  // public-facing token guess surface: fail closed
  await Promise.all([
    enforceRateLimit(`user:${u.userId}:invite_accept`, 10, 3600, { failClosed: true }),
    enforceRateLimit(`ip:${ipKey(req)}:invite_accept`, 30, 3600, { failClosed: true }),
  ]);
  const rows = unwrapDb(await u.db.rpc('accept_invitation', { p_token: Body.parse(await readJson(req, JSON_LIMIT.token)).token })) as { out_org_id: string; out_role: string }[];
  return { org_id: rows[0].out_org_id, role: rows[0].out_role };
});
