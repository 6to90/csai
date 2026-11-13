import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** DATABASE §10: trim -> strip <> -> lowercase -> max 998. Empty => null (caller derives a synthetic id). */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/^<+|>+$/g, '').trim().toLowerCase().slice(0, 998);
  return v === '' ? null : v;
}
export const syntheticMessageId = (from: string, date: string, subject: string, body: string) =>
  `synthetic:${createHash('sha256').update(`${from}\n${date}\n${subject}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex')}`;

/** Inbound webhook body (provider-agnostic JSON). Everything is data; nothing in it can choose the org or a tool. */
export const InboundEmail = z.object({
  message_id: z.string().max(2000).optional(),
  in_reply_to: z.string().max(2000).optional(),
  references: z.array(z.string().max(2000)).max(50).optional(),
  to: z.array(z.string().max(254)).max(50).optional(),
  from: z.object({ email: z.string().trim().toLowerCase().email().max(254), name: z.string().max(200).optional() }),
  subject: z.string().max(1000).optional(),
  text: z.string().max(200_000).default(''),
  html: z.string().max(500_000).optional(),
  date: z.string().max(64).optional(),
  auto_submitted: z.boolean().optional(),
  attachments: z.array(z.object({ filename: z.string().max(255), mime: z.string().max(127).optional(), size: z.number().int().min(0).max(1e10).optional() })).max(20).optional(),
}).strict();
export type InboundEmail = z.infer<typeof InboundEmail>;

/** Normalised row stored in webhook_events.payload and later fed to process_inbound. */
export function toInboundMessage(e: InboundEmail) {
  const id = normalizeMessageId(e.message_id) ?? syntheticMessageId(e.from.email, e.date ?? '', e.subject ?? '', e.text);
  const refs = (e.references ?? []).map(normalizeMessageId).filter((x): x is string => !!x);
  return {
    external_id: id, from_kind: 'email', from_value: e.from.email, to: e.to ?? [], from_name: e.from.name ?? null, subject: e.subject ?? null,
    body: e.text || (e.html ? e.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : ''), content_type: 'text',
    in_reply_to: normalizeMessageId(e.in_reply_to), references: refs, auto: !!e.auto_submitted, attachments: e.attachments ?? [],
  };
}

export const SIGNATURE_TOLERANCE_SEC = 300;
/** signature = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)); timestamp (unix seconds) must be within ±5 min. Constant-time compare. */
export const signBody = (secret: string, ts: string, raw: string | Buffer) => createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
export function verifySignature(secret: string, ts: string | null, sig: string | null, raw: string | Buffer, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!ts || !sig || !/^\d{9,12}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  if (Math.abs(nowSec - Number(ts)) > SIGNATURE_TOLERANCE_SEC) return false;
  return timingSafeEqual(Buffer.from(signBody(secret, ts, raw), 'hex'), Buffer.from(sig.toLowerCase(), 'hex'));
}
