import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { InboundEmail, toInboundMessage, verifySignature } from '@/server/domain/email';
import { MimeError, parseMime } from '@/server/domain/mime';
import { enforceRateLimit, ipKey } from '@/server/security/ratelimit';
import { secrets } from '@/server/security/secrets-instance';
import { systemClient } from '@/server/security/system-client';

export const dynamic = 'force-dynamic';
const MAX_BYTES = 25 * 1024 * 1024;

// Order (API §11): channel by URL id (404, nothing stored) -> org's secret -> verify the RAW body (401, nothing stored) -> only then persist.
export const POST = route<{ id: string }>(async (req, { params }) => {
  await enforceRateLimit(`ip:${ipKey(req)}:webhook`, 600, 60, { failClosed: true });
  const id = z.string().uuid().safeParse(params.id);
  if (!id.success) throw new HttpError(404, 'not_found');
  const db = systemClient();
  const { data: ch } = await db.from('channel_accounts').select('org_id,kind,status,integration_id').eq('id', id.data).maybeSingle();
  if (!ch || ch.kind !== 'email' || !ch.integration_id) throw new HttpError(404, 'not_found');
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) throw new HttpError(413, 'payload_too_large');
  const raw = Buffer.from(await req.arrayBuffer());                        // signature is verified over the exact bytes received
  if (raw.length > MAX_BYTES) throw new HttpError(413, 'payload_too_large');
  const secret = await secrets().get(ch.org_id, ch.integration_id, 'webhook_secret');
  if (!secret || !verifySignature(secret, req.headers.get('x-signature-timestamp'), req.headers.get('x-signature'), raw)) throw new HttpError(401, 'unauthorized');
  // Two accepted bodies: a raw RFC 5322 message (Content-Type: message/rfc822; what an MTA/forwarder/Email Worker sends) or the normalised JSON.
  let parsed: InboundEmail;
  if ((req.headers.get('content-type') ?? '').toLowerCase().startsWith('message/rfc822')) {
    try { parsed = parseMime(raw); } catch (e) { throw e instanceof MimeError ? new HttpError(422, 'validation_failed', 'unparseable message') : new HttpError(422, 'validation_failed'); }
  } else {
    let json: unknown; try { json = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(422, 'validation_failed'); }
    parsed = InboundEmail.parse(json);
  }
  const msg = toInboundMessage(parsed);
  // Replays and provider re-deliveries hit the unique (org, channel, event id) and are acknowledged without side effects.
  const fresh = unwrapDb(await db.rpc('receive_webhook', { p_org: ch.org_id, p_channel: id.data, p_provider: 'email', p_event_id: msg.external_id, p_payload: msg })) as boolean;
  return { duplicate: !fresh };
});
