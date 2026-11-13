import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proof of mailbox ownership for invitation sign-up.
 * Possession of the invitation token proves nothing about the mailbox (an admin who was shown the link, or anyone who sees it, holds it too).
 * So the account is only created after the invitee presents a code that was delivered to the invited ADDRESS. The code is a keyed MAC over
 * (token, e-mail, time step): it cannot be computed without the server secret, is bound to one token and one address, and needs no storage.
 */
const STEP_MS = 15 * 60 * 1000;          // a code is accepted for the current and the previous step => 15-30 minutes

function key(): Buffer {
  const raw = process.env.SECRETS_MASTER_KEY;
  if (!raw) throw new Error('SECRETS_MASTER_KEY is required for invitation verification');
  return createHmac('sha256', raw).update('csai/invite-proof/v1').digest();      // domain-separated subkey: the master key itself is never used as a MAC key
}
function codeFor(token: string, email: string, step: number): string {
  const mac = createHmac('sha256', key()).update(`${createHash('sha256').update(token).digest('hex')}|${email.trim().toLowerCase()}|${step}`).digest();
  return String(mac.readUInt32BE(0) % 100_000_000).padStart(8, '0');
}

export const inviteCode = (token: string, email: string, now = Date.now()) => codeFor(token, email, Math.floor(now / STEP_MS));

export function verifyInviteCode(token: string, email: string, code: string, now = Date.now()): boolean {
  if (!/^\d{8}$/.test(code)) return false;
  const step = Math.floor(now / STEP_MS);
  let ok = false;
  for (const s of [step, step - 1]) {                                            // evaluate both: no early exit on the first match
    const a = Buffer.from(codeFor(token, email, s)), b = Buffer.from(code);
    ok = (a.length === b.length && timingSafeEqual(a, b)) || ok;
  }
  return ok;
}
