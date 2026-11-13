import { z } from 'zod';
import { preflight, withCors } from '@/server/chat';
import { HttpError, route } from '@/server/http';
import { enforceRateLimit, ipKey } from '@/server/security/ratelimit';
import { systemClient } from '@/server/security/system-client';

export const OPTIONS = preflight;
// Public: cosmetic settings only, and only for an Origin the widget is allowed on (so the endpoint does not reveal widgets to anyone else).
export const GET = withCors(route(async (req) => {
  await enforceRateLimit(`ip:${ipKey(req)}:chat_config`, 120, 3600, { failClosed: true });
  const key = z.string().regex(/^[a-f0-9]{32}$/).safeParse(new URL(req.url).searchParams.get('public_key'));
  if (!key.success) throw new HttpError(404, 'not_found');
  const { data: ch } = await systemClient().from('channel_accounts').select('name,status,config').eq('public_key', key.data).eq('kind', 'web_chat').maybeSingle();
  const c = (ch?.config ?? {}) as { allowed_origins?: string[]; title?: string; greeting?: string; color?: string };
  if (!ch || ch.status !== 'active' || !c.allowed_origins?.includes(req.headers.get('origin') ?? '')) throw new HttpError(404, 'not_found');
  // `api` is the wire-contract major version: widgets that only know an older one disable themselves instead of misbehaving.
  return { api: 1, title: c.title || ch.name, greeting: c.greeting ?? '', color: c.color ?? '#6E8BFF' };
}));
