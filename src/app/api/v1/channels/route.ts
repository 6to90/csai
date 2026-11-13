import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';
import { enforceRateLimit } from '@/server/security/ratelimit';
import { secrets } from '@/server/security/secrets-instance';

export const GET = route(async (req) => {
  const c = await requireOrg(req, 'admin');
  return unwrapDb(await c.db.from('channel_accounts').select('id,kind,name,address,status,public_key,config,created_at').eq('org_id', c.orgId).order('created_at'));
});

export const Origin = z.string().url().max(200).refine((u) => new URL(u).origin === u && /^https?:$/.test(new URL(u).protocol), 'origin only');
const Body = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), name: z.string().trim().min(1).max(120), address: z.string().trim().toLowerCase().email().max(254), from_name: z.string().trim().max(100).optional(), smtp_url: z.string().max(500).regex(/^smtp(s|\+starttls)?:\/\//).optional() }).strict(),
  z.object({ kind: z.literal('web_chat'), name: z.string().trim().min(1).max(120), allowed_origins: z.array(Origin).min(1).max(10), title: z.string().trim().max(40).optional(), greeting: z.string().trim().max(200).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict(),
]);

// Secrets are write-only: the webhook signing secret is generated here, stored encrypted, and returned in THIS response only.
export const POST = route(async (req) => {
  const c = await requireOrg(req, 'admin');
  await enforceRateLimit(`org:${c.orgId}:channel_create`, 20, 3600, { failClosed: false });
  const b = Body.parse(await req.json().catch(() => null));
  const r = (unwrapDb(await c.db.rpc('create_channel_account', { p_org: c.orgId, p_kind: b.kind, p_name: b.name, p_address: b.kind === 'email' ? b.address : null, p_config: b.kind === 'web_chat' ? { allowed_origins: b.allowed_origins, title: b.title, greeting: b.greeting, color: b.color } : { from_name: b.from_name ?? '' } })) as { out_id: string; out_public_key: string | null; out_integration_id: string | null }[])[0];
  if (b.kind === 'web_chat') {
    // public_key identifies the widget (safe to embed); identity_secret stays on the customer's server and is shown once.
    const identity = randomBytes(32).toString('hex');
    await secrets().put(c.orgId, r.out_integration_id!, 'identity_secret', identity);
    return Response.json({ data: { id: r.out_id, public_key: r.out_public_key, identity_secret: identity } }, { status: 201, headers: { 'cache-control': 'no-store' } });
  }
  const secret = randomBytes(32).toString('hex');
  await secrets().put(c.orgId, r.out_integration_id!, 'webhook_secret', secret);
  if (b.smtp_url) await secrets().put(c.orgId, r.out_integration_id!, 'smtp_url', b.smtp_url);
  return Response.json({ data: { id: r.out_id, webhook_path: `/api/v1/webhooks/email/${r.out_id}`, webhook_secret: secret } }, { status: 201, headers: { 'cache-control': 'no-store' } });
});
