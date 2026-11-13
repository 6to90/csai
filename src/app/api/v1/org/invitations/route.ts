import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';
import { enforceRateLimit } from '@/server/security/ratelimit';
import { deliverInvitation } from '@/server/invitations';
import { JSON_LIMIT, readJson } from '@/server/http-body';

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['admin', 'agent', 'viewer']) });

export const GET = route(async (req) => {
  const c = await requireOrg(req, 'admin');
  // token_hash is not selectable by the authenticated role (column grants), and is never listed.
  return unwrapDb(await c.db.from('invitations').select('id,email,role,status,expires_at,created_at').eq('org_id', c.orgId).order('created_at', { ascending: false }).limit(100));
});

// No Idempotency-Key replay here on purpose: the response carries the one-time token and must not be stored.
// The link goes out by e-mail when MAIL_TRANSPORT is set (accept_url is then omitted). Duplicates are rejected by the partial unique index (409).
export const POST = route(async (req) => {
  const c = await requireOrg(req, 'admin');
  await enforceRateLimit(`org:${c.orgId}:invite`, 20, 3600, { failClosed: false });
  const b = Body.parse(await readJson(req, JSON_LIMIT.tiny));
  const rows = unwrapDb(await c.db.rpc('create_invitation', { p_org: c.orgId, p_email: b.email, p_role: b.role })) as { inv_id: string; inv_token: string; inv_expires_at: string }[];
  const r = rows[0];
  return Response.json({ data: { id: r.inv_id, email: b.email, role: b.role, expires_at: r.inv_expires_at, ...(await deliverInvitation(c.db, c.orgId, b.email, r.inv_token, r.inv_expires_at)) } }, { status: 201, headers: { 'cache-control': 'no-store' } });
});
