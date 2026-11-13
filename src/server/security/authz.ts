import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBearerClient, createCookieClient } from '@/lib/supabase/server';
import { HttpError } from '../http';

export type Role = 'owner' | 'admin' | 'agent' | 'viewer';
const RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };
export const hasMinRole = (role: Role, min: Role) => RANK[role] >= RANK[min];

export interface AuthContext { userId: string; db: SupabaseClient; email?: string; accessToken?: string }
export interface OrgContext extends AuthContext { orgId: string; role: Role; aal: string }

/**
 * CSRF defense for cookie-authenticated, state-changing requests: the browser must prove same-origin via Origin
 * (or Sec-Fetch-Site). Bearer-token requests are not ambient credentials and are exempt.
 */
export function assertSameOrigin(req: Request): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const expected = new URL(process.env.APP_URL || req.url).origin;
  const origin = req.headers.get('origin');
  if (origin ? origin === expected : req.headers.get('sec-fetch-site') === 'same-origin') return;
  throw new HttpError(403, 'forbidden', 'cross-origin request rejected');
}

/** Authenticates via Bearer token or session cookie. Uses auth.getUser() (server-validated), never trusts an unverified cookie. */
export async function requireUser(req: Request): Promise<AuthContext> {
  const h = req.headers.get('authorization');
  const token = h?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token && req.headers.get('cookie')) assertSameOrigin(req); // cookie-less requests carry no ambient credential => plain 401 below
  const db = token ? createBearerClient(token) : await createCookieClient();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'unauthorized');
  const accessToken = token ?? (await db.auth.getSession()).data.session?.access_token;   // already validated by getUser above
  return { userId: data.user.id, db, email: data.user.email, accessToken };
}

/** Authenticator assurance level claim ('aal1' | 'aal2') of an access token that GoTrue has just validated. */
export function aalOf(token?: string): string {
  try { return JSON.parse(Buffer.from(token!.split('.')[1], 'base64url').toString()).aal ?? 'aal1'; } catch { return 'aal1'; }
}

/**
 * The org comes from X-Org-Id but is only a hint: it is validated against the caller's own membership
 * (RLS-scoped query). A foreign or unknown org yields 404 (existence is not revealed).
 */
export async function requireOrg(req: Request, min: Role): Promise<OrgContext> {
  const user = await requireUser(req);
  const parsed = z.string().uuid().safeParse(req.headers.get('x-org-id'));
  if (!parsed.success) throw new HttpError(422, 'validation_failed', 'X-Org-Id header (uuid) required');
  const { data, error } = await user.db.from('memberships').select('role').eq('org_id', parsed.data).eq('user_id', user.userId).maybeSingle();
  if (error) throw new HttpError(500, 'internal');
  if (!data) throw new HttpError(404, 'not_found');
  if (!hasMinRole(data.role as Role, min)) throw new HttpError(403, 'forbidden');
  // Privileged roles (owner/admin) must hold an MFA-verified (aal2) session. The DB enforces the same rule (has_role + RPC guards).
  const aal = aalOf(user.accessToken);
  if ((data.role === 'owner' || data.role === 'admin') && aal !== 'aal2') throw new HttpError(403, 'mfa_required', 'multi-factor authentication required for this role');
  return { ...user, orgId: parsed.data, role: data.role as Role, aal };
}
