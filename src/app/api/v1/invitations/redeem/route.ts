import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { enforceRateLimit, ipKey } from '@/server/security/ratelimit';
import { systemClient } from '@/server/security/system-client';

// Public. Creates the account for a NEW invitee: possession of the (single-use, hashed, e-mailed) token proves control of the invited address.
// The token is NOT consumed here; the client then signs in (CAPTCHA-gated GoTrue) and calls /invitations/accept, which enforces
// e-mail match, expiry and single use. An address that already has an account never gets its password touched (409).
const Body = z.object({ token: z.string().min(20).max(200), password: z.string().min(10).max(128) });
export const POST = route(async (req) => {
  const b = Body.parse(await req.json().catch(() => null));
  const th = createHash('sha256').update(b.token).digest('hex').slice(0, 24);
  await Promise.all([
    enforceRateLimit(`ip:${ipKey(req)}:invite_redeem`, 20, 3600, { failClosed: true }),
    enforceRateLimit(`tok:${th}:invite_redeem`, 5, 3600, { failClosed: true }),
  ]);
  const db = systemClient();
  const rows = unwrapDb(await db.rpc('invitation_preview', { p_token: b.token })) as { out_email: string; out_has_account: boolean }[];
  if (!rows?.length) throw new HttpError(404, 'invitation_invalid', 'invitation is invalid');
  if (rows[0].out_has_account) throw new HttpError(409, 'account_exists', 'sign in instead');
  const { error } = await db.auth.admin.createUser({ email: rows[0].out_email, password: b.password, email_confirm: true });
  if (error) {
    if (error.code === 'weak_password') throw new HttpError(422, 'weak_password', 'password too weak');
    // a concurrent redeem may have just created the account (GoTrue then fails with varying codes): re-check before calling it an error
    const again = unwrapDb(await db.rpc('invitation_preview', { p_token: b.token })) as { out_has_account: boolean }[];
    throw again?.[0]?.out_has_account ? new HttpError(409, 'account_exists', 'sign in instead') : new HttpError(500, 'internal');
  }
  return Response.json({ data: { email: rows[0].out_email } }, { status: 201 });
});
