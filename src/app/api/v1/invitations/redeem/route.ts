import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { sendInviteCodeMail } from '@/server/adapters/mail';
import { inviteCode, verifyInviteCode } from '@/server/domain/invite-proof';
import { log } from '@/server/log';
import { maskEmail } from '@/server/security/mask';
import { enforceRateLimit, ipKey } from '@/server/security/ratelimit';
import { systemClient } from '@/server/security/system-client';

// Public. Creates the account for a NEW invitee, but only after PROOF OF MAILBOX: the invitation token alone is not proof (whoever was shown the
// link holds it). Two calls with the same body shape:
//   1) { token, password }        -> a one-time code is e-mailed to the invited address (202). Nothing is created.
//   2) { token, password, code }  -> the code is verified, then the (confirmed) account is created (201).
// The token is NOT consumed here; the client then signs in (CAPTCHA-gated GoTrue) and calls /invitations/accept, which enforces
// confirmed e-mail == invited e-mail, expiry and single use. An address that already has an account never gets its password touched (409).
const Body = z.object({ token: z.string().min(20).max(200), password: z.string().min(10).max(128), code: z.string().regex(/^\d{8}$/).optional() });
export const POST = route(async (req) => {
  const b = Body.parse(await req.json().catch(() => null));
  const th = createHash('sha256').update(b.token).digest('hex').slice(0, 24);
  await Promise.all([
    enforceRateLimit(`ip:${ipKey(req)}:invite_redeem`, 20, 3600, { failClosed: true }),
    enforceRateLimit(`tok:${th}:invite_redeem`, 10, 3600, { failClosed: true }),
  ]);
  const db = systemClient();
  const rows = unwrapDb(await db.rpc('invitation_preview', { p_token: b.token })) as { out_email: string; out_has_account: boolean }[];
  if (!rows?.length) throw new HttpError(404, 'invitation_invalid', 'invitation is invalid');
  if (rows[0].out_has_account) throw new HttpError(409, 'account_exists', 'sign in instead');
  const email = rows[0].out_email;   // always the invited address from the DB, never anything from the request

  if (!b.code) {
    await Promise.all([
      enforceRateLimit(`tok:${th}:invite_code_send`, 3, 3600, { failClosed: true }),   // cannot be used to spam the invitee's mailbox
      enforceRateLimit(`ip:${ipKey(req)}:invite_code_send`, 10, 3600, { failClosed: true }),
    ]);
    const code = inviteCode(b.token, email);
    const sent = await sendInviteCodeMail(email, code);
    if (!sent) {
      // No way to prove mailbox ownership => no account. Never fall back to trusting the link.
      if (process.env.NODE_ENV === 'production') throw new HttpError(503, 'mail_unavailable', 'verification e-mail could not be sent');
      log('warn', 'invite verification code not mailed (no transport; dev only)', { email: maskEmail(email), code });   // dev-only visibility of the code, never in production
    }
    return Response.json({ data: { code_sent: true, email_hint: maskEmail(email) } }, { status: 202, headers: { 'cache-control': 'no-store' } });
  }

  await enforceRateLimit(`tok:${th}:invite_code_try`, 5, 3600, { failClosed: true });   // 8-digit code: guessing is bounded to 5 tries/hour per link
  if (!verifyInviteCode(b.token, email, b.code)) throw new HttpError(422, 'invalid_code', 'verification code is invalid or expired');
  const { error } = await db.auth.admin.createUser({ email, password: b.password, email_confirm: true });   // confirmed: the code proved the mailbox
  if (error) {
    if (error.code === 'weak_password') throw new HttpError(422, 'weak_password', 'password too weak');
    // a concurrent redeem may have just created the account (GoTrue then fails with varying codes): re-check before calling it an error
    const again = unwrapDb(await db.rpc('invitation_preview', { p_token: b.token })) as { out_has_account: boolean }[];
    throw again?.[0]?.out_has_account ? new HttpError(409, 'account_exists', 'sign in instead') : new HttpError(500, 'internal');
  }
  return Response.json({ data: { email } }, { status: 201, headers: { 'cache-control': 'no-store' } });
});
