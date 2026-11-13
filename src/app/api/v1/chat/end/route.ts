import { preflight, requireChatSession, withCors } from '@/server/chat';
import { route } from '@/server/http';
import { systemClient } from '@/server/security/system-client';

export const OPTIONS = preflight;
// The visitor leaves: only THEIR session is revoked (the conversation stays for the agents).
export const POST = withCors(route(async (req) => {
  const s = await requireChatSession(req);
  await systemClient().from('chat_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', s.id).eq('org_id', s.org_id).is('revoked_at', null);
  return { ok: true };
}));
