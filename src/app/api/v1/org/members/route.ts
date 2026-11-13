import { route, unwrapDb } from '@/server/http';
import { requireOrg } from '@/server/security/authz';

export const GET = route(async (req) => {
  const c = await requireOrg(req, 'viewer');
  // owner/admin: everyone with e-mail; others: only themselves (enforced inside the RPC, which also requires aal2 for privileged roles)
  const rows = unwrapDb(await c.db.rpc('list_members', { p_org: c.orgId })) as { out_id: string; out_user_id: string; out_email: string; out_role: string; out_created_at: string }[];
  return rows.map((r) => ({ id: r.out_id, user_id: r.out_user_id, email: r.out_email, role: r.out_role, created_at: r.out_created_at }));
});
