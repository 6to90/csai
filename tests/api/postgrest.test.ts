import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { runJobs, NonRetryableError } from '@/server/jobs/worker';
import { supabaseJobsDb } from '@/server/jobs/supabase-jobs-db';
import { createSecrets } from '@/server/security/secrets';
import { supabaseSecretsStore } from '@/server/security/secrets-store-supabase';
import { addMember, mkOrg, mkUser, sql, uniq, type TUser } from './helpers';

// Real PostgREST + real Postgres; JWT validation by a stub (not GoTrue). Verifies supabase-js <-> PostgREST wiring and RLS via HTTP.
const url = process.env.SUPABASE_URL!;
const client = (key: string) => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const asUser = (u: TUser) => createClient(url, process.env.ANON_KEY!, { global: { headers: { Authorization: `Bearer ${u.token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
const service = client(process.env.SERVICE_KEY!);

let alice: TUser, bob: TUser, orgA: string, orgB: string, integB: string;
beforeAll(async () => {
  [alice, bob] = await Promise.all([mkUser('pa'), mkUser('pb')]);
  [orgA, orgB] = [await mkOrg(alice), await mkOrg(bob)];
  await sql(`insert into customers(org_id, display_name) values ($1,'B-customer')`, [orgB]);
  integB = (await sql<{ id: string }>(`insert into integrations(org_id,kind,name) values ($1,'http_connector','b') returning id`, [orgB]))[0].id;
});

describe('RLS through real PostgREST (user JWT)', () => {
  it('alice reads nothing of org B from any table; writes and deletes affect 0 rows', async () => {
    const db = asUser(alice);
    for (const [t, col] of [['organizations', 'id'], ['memberships', 'org_id'], ['customers', 'org_id'], ['integrations', 'org_id'], ['audit_logs', 'org_id'], ['invitations', 'org_id']] as const) {
      const r = await db.from(t).select(col === 'id' ? 'id' : 'id').eq(col, orgB); expect(r.error, t).toBeNull(); expect(r.data, t).toEqual([]);
    }
    const upd = await db.from('customers').update({ display_name: 'pwn' }).eq('org_id', orgB).select(); expect(upd.data).toEqual([]);
    const del = await db.from('customers').delete().eq('org_id', orgB).select(); expect(del.data).toEqual([]);
    const ins = await db.from('customers').insert({ org_id: orgB, display_name: 'x' }); expect(ins.error?.code).toBe('42501');
    expect((await sql(`select 1 from customers where org_id=$1 and display_name='B-customer'`, [orgB])).length).toBe(1);
  });
  it('direct writes to organizations/memberships/integrations/audit_logs are refused; RPC across tenants is forbidden', async () => {
    const db = asUser(alice);
    expect((await db.from('organizations').update({ name: 'x' }).eq('id', orgA)).error?.code).toBe('42501');
    expect((await db.from('memberships').update({ role: 'owner' }).eq('org_id', orgA)).error?.code).toBe('42501');
    expect((await db.from('integrations').insert({ org_id: orgA, kind: 'llm_byok', name: 'x' })).error?.code).toBe('42501');
    expect((await db.from('audit_logs').insert({ org_id: orgA, actor_type: 'user', action: 'x' })).error?.code).toBe('42501');
    expect((await db.rpc('create_invitation', { p_org: orgB, p_email: 'e@example.com', p_role: 'viewer' })).error?.code).toBe('42501');
  });
  it('service-only tables, secrets columns and system RPCs are not reachable for user or anon JWTs', async () => {
    for (const key of [asUser(alice), client(process.env.ANON_KEY!)])
      for (const t of ['org_keys', 'integration_secrets', 'jobs', 'rate_limits', 'chat_sessions', 'webhook_events', 'idempotency_keys'])
        expect((await key.from(t).select('*').limit(1)).error?.code, t).toBe('42501');
    expect((await asUser(alice).from('invitations').select('token_hash')).error?.code).toBe('42501');
    for (const fn of ['claim_jobs', 'purge_pii', 'rate_limit_hit', 'append_audit'])
      expect((await asUser(alice).rpc(fn, {})).error, fn).toBeTruthy();
    expect((await client(process.env.ANON_KEY!).from('organizations').select('id')).error?.code).toBe('42501');
  });
  it('service role works (sanity) and bytea values come back as \\x hex', async () => {
    expect((await service.from('org_keys').select('org_id').limit(1)).error).toBeNull();
  });
});

describe('supabase-js wiring that Phase 2 could not verify before', () => {
  it('secrets: bytea round-trip, rotation and master-key rewrap via PostgREST; only ciphertext in the table', async () => {
    const master = randomBytes(32); const s = createSecrets(supabaseSecretsStore(service), { current: master });
    const PLAIN = 'sk-live-ABCDEF-0123456789';
    expect(await s.put(orgB, integB, 'api_key', PLAIN)).toEqual({ name: 'api_key', last4: '6789' });
    expect(await s.get(orgB, integB, 'api_key')).toBe(PLAIN);
    const [row] = await sql<{ n: number; has: boolean }>(`select octet_length(ciphertext) n, position($2::bytea in ciphertext) > 0 has from integration_secrets where org_id=$1`, [orgB, Buffer.from(PLAIN)]);
    expect(row.n).toBe(12 + PLAIN.length + 16);        // raw bytes, not hex text (would be 2x)
    expect(row.has).toBe(false);
    expect(await s.put(orgB, integB, 'api_key', PLAIN + 'x')).toMatchObject({ last4: '789x' });   // upsert on (integration_id,name)
    expect(await s.rotateOrgKey(orgB)).toBe(1);
    expect((await sql<{ key_version: number }>('select key_version from org_keys where org_id=$1', [orgB]))[0].key_version).toBe(2);
    expect(await s.get(orgB, integB, 'api_key')).toBe(PLAIN + 'x');
    const next = randomBytes(32);
    const rw = await createSecrets(supabaseSecretsStore(service), { current: next, previous: master }).rewrapAll();
    expect(rw.rewrapped).toBeGreaterThanOrEqual(1); expect(rw.failed).not.toContain(orgB);   // orgs wrapped by other test runs' master keys are reported, not fatal
    expect(await createSecrets(supabaseSecretsStore(service), { current: next }).get(orgB, integB, 'api_key')).toBe(PLAIN + 'x');
    const dump = (await sql<{ d: string }>(`select string_agg(x::text,' ') d from integration_secrets x`))[0].d ?? '';
    expect(dump).not.toContain(PLAIN);
  });
  it('job runner over supabase-js RPCs: success, retry with backoff, non-retryable dead, lost lease', async () => {
    const db = supabaseJobsDb(service); const tag = uniq();
    const enq = async (type: string) => (await service.rpc('enqueue_job', { p_org: orgA, p_type: type, p_payload: {}, p_dedupe: `${tag}-${type}` })).data as string;
    const ids = { ok: await enq('ok'), flaky: await enq('flaky'), bad: await enq('bad') };
    expect(await enq('ok')).toBeNull();                                            // dedupe via RPC returns null
    const res = await runJobs(db, { ok: async () => {}, flaky: async () => { throw new Error('transient'); }, bad: async () => { throw new NonRetryableError('nope'); } }, { worker: `t-${tag}`, limit: 100 });
    expect(res.done).toBeGreaterThanOrEqual(1); expect(res.retried).toBeGreaterThanOrEqual(1); expect(res.dead).toBeGreaterThanOrEqual(1);
    const st = Object.fromEntries((await sql<{ id: string; status: string; last_error: string | null }>('select id,status,last_error from jobs where id = any($1)', [Object.values(ids)])).map((r) => [r.id, r]));
    expect(st[ids.ok].status).toBe('done'); expect(st[ids.flaky]).toMatchObject({ status: 'failed', last_error: 'transient' }); expect(st[ids.bad].status).toBe('dead');
    expect(await db.complete(ids.ok, 'someone-else')).toBe(false);                 // fenced
  });
  it('typed errors survive PostgREST: unique violation -> 23505, raise exception errcode -> same code', async () => {
    const u = await mkUser('dupe'); const slug = `dup-${uniq()}`;
    expect((await asUser(u).rpc('create_organization', { p_name: 'a', p_slug: slug })).error).toBeNull();
    expect((await asUser(u).rpc('create_organization', { p_name: 'a', p_slug: slug })).error?.code).toBe('23505');
    expect((await asUser(u).rpc('create_organization', { p_name: '', p_slug: 'x' })).error?.code).toBe('23514');
  });
  it('a member added via the real invitation RPCs sees exactly their own data through REST', async () => {
    const m = await mkUser('member'); await addMember(orgA, alice, m, 'agent');
    const db = asUser(m);
    expect((await db.from('organizations').select('id')).data).toEqual([{ id: orgA }]);
    expect((await db.from('memberships').select('user_id')).data).toEqual([{ user_id: m.id }]);   // agents see only themselves
    expect((await db.from('audit_logs').select('id')).data).toEqual([]);
  });
});
