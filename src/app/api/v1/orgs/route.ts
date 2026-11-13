import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireUser } from '@/server/security/authz';
import { enforceRateLimit } from '@/server/security/ratelimit';
import { JSON_LIMIT, readJson } from '@/server/http-body';

const Body = z.object({ name: z.string().trim().min(1).max(120), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/) });
// Creation is naturally idempotent via the unique slug (409 on repeat); audit is written inside the RPC.
export const POST = route(async (req) => {
  const u = await requireUser(req);
  await enforceRateLimit(`user:${u.userId}:org_create`, 5, 3600, { failClosed: false });
  const b = Body.parse(await readJson(req, JSON_LIMIT.tiny));
  const id = unwrapDb(await u.db.rpc('create_organization', { p_name: b.name, p_slug: b.slug }));
  return Response.json({ data: { id } }, { status: 201 });
});
