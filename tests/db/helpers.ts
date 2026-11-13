import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 40 });
export const uniq = () => randomUUID().slice(0, 8);

type Role = 'authenticated' | 'anon' | 'service_role';
/** Runs one statement in its own committed transaction as a given DB role (+JWT subject), like PostgREST does. */
export async function as<T = Record<string, unknown>>(role: Role, uid: string | null, sql: string, params: unknown[] = [], aal: 'aal1' | 'aal2' = 'aal2'): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    // PostgREST exposes the verified JWT as the JSON GUC request.jwt.claims; auth.uid()/auth.jwt() read it.
    if (uid) await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role, aal })]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows as T[];
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}
export const user = <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) => as<T>('authenticated', uid, sql, p);
/** Same as user() but with a password-only (aal1) session — what an owner/admin has before completing MFA. */
export const userAal1 = <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) => as<T>('authenticated', uid, sql, p, 'aal1');
export const svc = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => as<T>('service_role', null, sql, p);
/** Superuser (bypasses RLS) — test setup/inspection only. */
export const sup = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as T[];

export async function mkUser(label: string, confirmed = true): Promise<{ id: string; email: string }> {
  const email = `${label}-${uniq()}@example.com`;
  const [r] = await sup<{ id: string }>('insert into auth.users(id, email, email_confirmed_at) values (gen_random_uuid(), $1, $2) returning id', [email, confirmed ? new Date() : null]);
  return { id: r.id, email };
}
export async function mkOrg(ownerId: string, name = 'Org'): Promise<string> {
  return (await user<{ create_organization: string }>(ownerId, 'select create_organization($1, $2)', [name, `org-${uniq()}`]))[0].create_organization;
}
/** Owner invites `target` with `role` and the target accepts. Returns membership id. */
export async function addMember(orgId: string, inviterId: string, target: { id: string; email: string }, role: string): Promise<string> {
  const [inv] = await user<{ inv_token: string }>(inviterId, 'select * from create_invitation($1,$2,$3)', [orgId, target.email, role]);
  await user(target.id, 'select * from accept_invitation($1)', [inv.inv_token]);
  return (await sup<{ id: string }>('select id from memberships where org_id=$1 and user_id=$2', [orgId, target.id]))[0].id;
}
export const rejects = async (p: Promise<unknown>, match: RegExp) => {
  await p.then(() => { throw new Error('expected rejection'); }, (e: Error) => { if (!match.test(e.message)) throw e; });
};
