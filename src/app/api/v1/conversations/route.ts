import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';

const Q = z.object({
  status: z.enum(['open', 'pending_approval', 'waiting_customer', 'resolved', 'closed']).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  unread: z.literal('1').optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});
const COLS = 'id,status,priority,assignee_id,subject,last_message_at,last_message_preview,unread_count,channel_account_id,customer_id,created_at,customer:customers(id,display_name,email)';

// RLS-scoped with the caller's JWT; org_id is still filtered explicitly (defense in depth).
export const GET = route(async (req) => {
  const c = await requireOrg(req, 'viewer');
  const p = Q.parse(Object.fromEntries(new URL(req.url).searchParams));
  let q = c.db.from('conversations').select(COLS).eq('org_id', c.orgId).order('last_message_at', { ascending: false, nullsFirst: false }).limit(p.limit);
  if (p.status) q = q.eq('status', p.status);
  if (p.priority) q = q.eq('priority', p.priority);
  if (p.unread) q = q.gt('unread_count', 0);
  if (p.assignee === 'me') q = q.eq('assignee_id', c.userId); else if (p.assignee === 'unassigned') q = q.is('assignee_id', null); else if (p.assignee) q = q.eq('assignee_id', p.assignee);
  if (p.before) q = q.lt('last_message_at', p.before);
  if (p.q) {
    const t = p.q.replace(/[%_*,()\\]/g, ' ').trim();                                   // keep PostgREST filter syntax and LIKE wildcards out of user text
    if (t) {
      const { data: cs } = await c.db.from('customers').select('id').eq('org_id', c.orgId).or(`display_name.ilike.%${t}%,email.ilike.%${t}%`).limit(200);
      const ids = (cs ?? []).map((x) => x.id);
      q = q.or([`subject.ilike.%${t}%`, ids.length ? `customer_id.in.(${ids.join(',')})` : null].filter(Boolean).join(','));
    }
  }
  return unwrapDb(await q);
});
