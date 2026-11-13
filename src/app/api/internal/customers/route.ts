import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { deliverInvitation } from '@/server/invitations';
import { systemClient } from '@/server/security/system-client';
import { JSON_LIMIT, readJson } from '@/server/http-body';

export const dynamic = 'force-dynamic';
const digest = (s: string) => createHash('sha256').update(s).digest();
const Body = z.object({ email: z.string().trim().toLowerCase().email().max(254), org_name: z.string().trim().min(1).max(120), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/) });

// Operator-only (CRON_SECRET): provisions a customer organisation and invites its first owner. Safe to repeat for the same (email, slug): re-issues the link.
export const POST = route(async (req) => {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  if (!secret || !timingSafeEqual(digest(given), digest(secret))) throw new HttpError(401, 'unauthorized');
  const b = Body.parse(await readJson(req, JSON_LIMIT.small));
  const db = systemClient();
  const r = (unwrapDb(await db.rpc('provision_customer', { p_email: b.email, p_org_name: b.org_name, p_slug: b.slug })) as { out_org: string; out_inv: string; out_token: string; out_expires: string }[])[0];
  return Response.json({ data: { org_id: r.out_org, invitation_id: r.out_inv, expires_at: r.out_expires, ...(await deliverInvitation(db, r.out_org, b.email, r.out_token, r.out_expires)) } }, { status: 201, headers: { 'cache-control': 'no-store' } });
});
