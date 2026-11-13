import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cleanText, hashToken, preflight, withCors } from '@/server/chat';
import { HttpError, route, unwrapDb } from '@/server/http';
import { enforceRateLimit, ipKey } from '@/server/security/ratelimit';
import { secrets } from '@/server/security/secrets-instance';
import { systemClient } from '@/server/security/system-client';
import { JSON_LIMIT, readJson } from '@/server/http-body';

export const OPTIONS = preflight;
const Body = z.object({
  public_key: z.string().regex(/^[a-f0-9]{32}$/), visitor_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), name: z.string().trim().max(120).optional(),
  // Optional identity verification: the customer's BACKEND signs the e-mail with the widget's identity secret (never exposed to browsers).
  email: z.string().trim().toLowerCase().email().max(254).optional(), email_hash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
}).strict().refine((b) => !b.email === !b.email_hash, 'email and email_hash go together');

// Public. The channel is found by public_key (an identifier, not a credential); the Origin must be in that channel's allowed_origins (checked in the RPC).
export const POST = withCors(route(async (req) => {
  await enforceRateLimit(`ip:${ipKey(req)}:chat_session`, 30, 3600, { failClosed: true });
  const b = Body.parse(await readJson(req, JSON_LIMIT.small));
  const db = systemClient();
  if (b.email) {
    const { data: ch } = await db.from('channel_accounts').select('org_id,integration_id').eq('public_key', b.public_key).eq('kind', 'web_chat').maybeSingle();
    const secret = ch?.integration_id ? await secrets().get(ch.org_id, ch.integration_id, 'identity_secret') : null;
    const want = secret ? createHmac('sha256', secret).update(b.email).digest() : null;
    const got = Buffer.from(b.email_hash!, 'hex');
    // A bad/absent proof is refused, never silently downgraded to an anonymous visitor.
    if (!want || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(403, 'identity_invalid', 'identity could not be verified');
  }
  const token = randomBytes(32).toString('base64url');
  let rows;
  try { rows = unwrapDb(await db.rpc('chat_start', { p_public_key: b.public_key, p_origin: req.headers.get('origin'), p_visitor: b.visitor_id, p_name: b.name ? cleanText(b.name) : null, p_token_hash: hashToken(token), p_ip_hash: ipKey(req), p_email: b.email ?? null })) as { out_conv: string }[]; }
  catch (e) { throw e instanceof HttpError && e.status === 404 ? new HttpError(403, 'forbidden', 'chat is not available for this origin') : e; }
  return Response.json({ data: { token, conversation_id: rows[0].out_conv } }, { status: 201, headers: { 'cache-control': 'no-store' } });
}));
