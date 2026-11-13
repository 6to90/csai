import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError, route } from '@/server/http';
import { runJobs, type Handlers } from '@/server/jobs/worker';
import { supabaseJobsDb } from '@/server/jobs/supabase-jobs-db';
import { inboxHandlers } from '@/server/jobs/inbox-handlers';
import { systemClient } from '@/server/security/system-client';

export const dynamic = 'force-dynamic';
const digest = (s: string) => createHash('sha256').update(s).digest();
// Unknown job types are failed as non-retryable.
const handlers: Handlers = { ...inboxHandlers };

export const POST = route(async (req) => {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  if (!secret || !timingSafeEqual(digest(given), digest(secret))) throw new HttpError(401, 'unauthorized');
  const db = systemClient();
  // Global maintenance is idempotent and org-less, so it runs directly rather than through the org-scoped jobs table.
  const [inv, rl, pii] = await Promise.all([db.rpc('expire_invitations'), db.rpc('purge_rate_limits'), db.rpc('purge_pii')]);
  if (inv.error || rl.error || pii.error) throw new HttpError(500, 'internal');
  return { ...(await runJobs(supabaseJobsDb(db), handlers, { worker: `w-${randomUUID()}` })), maintenance: { invitations_expired: inv.data, rate_limits_purged: rl.data } };
});
