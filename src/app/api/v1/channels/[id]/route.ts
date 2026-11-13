import { z } from 'zod';
import { HttpError, route, unwrapDb } from '@/server/http';
import { Origin } from '../route';
import { requireOrg } from '@/server/security/authz';

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const c = await requireOrg(req, 'admin');
  const id = z.string().uuid().parse(params.id);
  const b = z.object({
    status: z.enum(['active', 'paused']).optional(), name: z.string().trim().min(1).max(120).optional(),
    widget: z.object({ allowed_origins: z.array(Origin).min(1).max(10).optional(), title: z.string().trim().max(40).optional(), greeting: z.string().trim().max(200).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict().optional(),
  }).strict().refine((x) => Object.keys(x).length > 0, 'no fields').parse(await req.json().catch(() => null));
  const { data: own } = await c.db.from('channel_accounts').select('id').eq('id', id).eq('org_id', c.orgId).maybeSingle();   // the header org must own the channel
  if (!own) throw new HttpError(404, 'not_found');
  if (b.status) unwrapDb(await c.db.rpc('set_channel_status', { p_id: id, p_status: b.status }));
  if (b.name || b.widget) unwrapDb(await c.db.rpc('update_widget', { p_id: id, p_name: b.name ?? null, p_config: b.widget ?? {} }));
  return { ok: true };
});
