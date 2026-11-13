import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { enforceRateLimit, ipKey } from '@/server/security/ratelimit';
import { systemClient } from '@/server/security/system-client';

// Public (token = capability). Anything but a live pending invitation answers the same 404 so state is not revealed.
export const POST = route(async (req) => {
  await enforceRateLimit(`ip:${ipKey(req)}:invite_preview`, 60, 3600, { failClosed: true });
  const { token } = z.object({ token: z.string().min(20).max(200) }).parse(await req.json().catch(() => null));
  const rows = unwrapDb(await systemClient().rpc('invitation_preview', { p_token: token })) as { out_org_name: string; out_email: string; out_role: string; out_has_account: boolean; out_expires: string }[];
  if (!rows?.length) throw new HttpError(404, 'invitation_invalid', 'invitation is invalid');
  const r = rows[0];
  return { org_name: r.out_org_name, email: r.out_email, role: r.out_role, has_account: r.out_has_account, expires_at: r.out_expires };
});
