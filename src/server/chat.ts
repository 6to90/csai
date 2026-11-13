import 'server-only';
import { createHash } from 'node:crypto';
import { HttpError } from './http';
import { systemClient } from './security/system-client';

export const hashToken = (t: string) => `\\x${createHash('sha256').update(t).digest('hex')}`;   // PostgREST bytea literal
const IDLE_MS = 30 * 60_000;

/** Visitor widgets run on customer sites: reflect the caller's Origin. This is NOT the access check (token + stored-origin match are). */
export function withCors(h: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    const res = await h(req); const o = req.headers.get('origin');
    if (o) { res.headers.set('access-control-allow-origin', o); res.headers.append('vary', 'Origin'); }
    return res;
  };
}
export const preflight = () => new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type,x-csai-widget-version', 'access-control-max-age': '600' } });

export interface ChatSession { id: string; org_id: string; channel_account_id: string; conversation_id: string; visitor_id: string; verified_email: string | null }
/** Visitor text is DATA: control characters (except \n and \t) are dropped before storage; it is only ever rendered as text. */
export const cleanText = (t: string) => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');

/** Opaque bearer token -> session. One token = one conversation. Unknown/expired/revoked/idle/other-origin all answer the same 401. */
export async function requireChatSession(req: Request): Promise<ChatSession> {
  const token = req.headers.get('authorization')?.match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/)?.[1];
  if (!token) throw new HttpError(401, 'unauthorized');
  const db = systemClient();
  const { data: s } = await db.from('chat_sessions').select('id,org_id,channel_account_id,conversation_id,visitor_id,verified_email,origin,expires_at,last_seen_at,revoked_at').eq('token_hash', hashToken(token)).maybeSingle();
  const now = Date.now();
  // Pausing the widget or removing an origin takes effect immediately for sessions that already exist.
  const { data: ch } = s ? await db.from('channel_accounts').select('status,config').eq('id', s.channel_account_id).eq('org_id', s.org_id).maybeSingle() : { data: null };
  const allowed = (ch?.config as { allowed_origins?: string[] } | null)?.allowed_origins ?? [];
  if (!s || !ch || ch.status !== 'active' || !allowed.includes(s.origin ?? '') || s.revoked_at || new Date(s.expires_at).getTime() <= now || now - new Date(s.last_seen_at).getTime() > IDLE_MS || req.headers.get('origin') !== s.origin) throw new HttpError(401, 'unauthorized');
  await db.from('chat_sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', s.id).eq('org_id', s.org_id);
  return s;
}
