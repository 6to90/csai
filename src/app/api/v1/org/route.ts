import { z } from 'zod';
import { route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';

export const GET = route(async (req) => {
  const c = await requireOrg(req, 'viewer');
  return unwrapDb(await c.db.from('organizations').select('id,name,slug,kill_switch,data_retention_days,created_at').eq('id', c.orgId).single());
});

// Only name and retention are editable here (slug/kill_switch/ownership are not). Goes through an audited RPC; direct UPDATE is revoked.
const Patch = z.object({ name: z.string().trim().min(1).max(120).optional(), data_retention_days: z.number().int().min(30).max(3650).optional() })
  .strict().refine((b) => Object.keys(b).length > 0, 'no fields');
export const PATCH = route(async (req) => {
  const c = await requireOrg(req, 'admin');
  const b = Patch.parse(await req.json().catch(() => null));
  unwrapDb(await c.db.rpc('update_organization', { p_org: c.orgId, p_name: b.name ?? null, p_retention_days: b.data_retention_days ?? null }));
  return { ok: true };
});
