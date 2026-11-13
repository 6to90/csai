import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, BASE, call, invite, mintJwt, mkOrg, mkUser, sql, tokenOf, uniq, upgradeToAal2, type TUser } from './helpers';

let alice: TUser, bob: TUser, admin: TUser, agent: TUser, viewer: TUser, orgA: string, orgB: string;
beforeAll(async () => {
  [alice, bob, admin, agent, viewer] = await Promise.all(['alice', 'bob', 'admin', 'agent', 'viewer'].map((l) => mkUser(l)));
  [orgA, orgB] = [await mkOrg(alice), await mkOrg(bob)];
  await addMember(orgA, alice, admin, 'admin'); await addMember(orgA, alice, agent, 'agent'); await addMember(orgA, alice, viewer, 'viewer');
});

describe('authentication', () => {
  it('health is public, minimal and carries security headers', async () => {
    const r = await call('GET', '/api/v1/health');
    expect(r.status).toBe(200); expect(r.body).toEqual({ data: { status: 'ok' } });
    expect(r.headers.get('x-content-type-options')).toBe('nosniff'); expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBeTruthy(); expect(r.headers.get('x-powered-by')).toBeNull(); expect(r.headers.get('cache-control')).toBe('no-store');
  });
  const protectedCalls: [string, string, unknown?][] = [
    ['GET', '/api/v1/org'], ['PATCH', '/api/v1/org', { name: 'x' }], ['GET', '/api/v1/org/members'], ['GET', '/api/v1/org/invitations'],
    ['POST', '/api/v1/org/invitations', { email: 'a@b.co', role: 'agent' }], ['POST', '/api/v1/orgs', { name: 'x', slug: 'xxx' }], ['POST', '/api/v1/invitations/accept', { token: 'x'.repeat(30) }],
  ];
  it.each(protectedCalls)('%s %s without credentials -> 401', async (m, p, body) => {
    const r = await call(m, p, { org: orgA, body });
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('unauthorized'); expect(r.body.error.request_id).toBeTruthy();
  });
  it('garbage, wrong-signature and expired tokens -> 401', async () => {
    for (const token of ['garbage', mintJwt(alice.id, { secret: 'another-secret-another-secret-another!!' }), mintJwt(alice.id, { exp: Math.floor(Date.now() / 1000) - 60 })])
      expect((await call('GET', '/api/v1/org', { user: { token }, org: orgA })).status).toBe(401);
  });
  it('valid JWT for a non-existent user -> 401', async () => {
    expect((await call('GET', '/api/v1/org', { user: { token: mintJwt(crypto.randomUUID()) }, org: orgA })).status).toBe(401);
  });
});

describe('organizations & validation', () => {
  it('creates an org (201), writes an audit row, rejects duplicate slug (409) and bad input (422)', async () => {
    const u = await mkUser('creator'); const slug = `org-${uniq()}`; const v = await mkUser('validator'); // org creation is limited to 5/h per user and invalid attempts count
    const r = await call('POST', '/api/v1/orgs', { user: u, body: { name: 'Acme', slug } });
    expect(r.status).toBe(201);
    const a = await sql<{ action: string; actor_id: string }>(`select action, actor_id from audit_logs where org_id=$1`, [r.body.data.id]);
    expect(a).toEqual([{ action: 'org.create', actor_id: u.id }]);
    expect((await call('POST', '/api/v1/orgs', { user: u, body: { name: 'Acme', slug } })).status).toBe(409);
    for (const body of [{}, { name: '', slug }, { name: 'x', slug: 'A!' }, { name: 'x', slug: 'ab' }]) expect((await call('POST', '/api/v1/orgs', { user: v, body })).status).toBe(422);
    const w = await mkUser('validator2');
    for (const body of [{ name: 'x'.repeat(121), slug: `ok-${uniq()}` }, 'str', null]) expect((await call('POST', '/api/v1/orgs', { user: w, body })).status).toBe(422);
    expect((await call('POST', '/api/v1/orgs', { user: w, raw: '{not json' })).status).toBe(422);
  });
  it('concurrent creates with one slug: exactly one wins', async () => {
    const slug = `race-${uniq()}`; const users = await Promise.all(Array.from({ length: 4 }, (_, i) => mkUser(`race${i}`)));
    const rs = await Promise.all(users.map((u) => call('POST', '/api/v1/orgs', { user: u, body: { name: 'R', slug } })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
  });
  it('X-Org-Id is validated: missing/invalid -> 422, foreign org -> 404 (existence hidden), own -> 200', async () => {
    expect((await call('GET', '/api/v1/org', { user: alice })).status).toBe(422);
    expect((await call('GET', '/api/v1/org', { user: alice, org: 'not-a-uuid' })).status).toBe(422);
    const foreign = await call('GET', '/api/v1/org', { user: alice, org: orgB });
    const missing = await call('GET', '/api/v1/org', { user: alice, org: crypto.randomUUID() });
    expect([foreign.status, missing.status]).toEqual([404, 404]); expect(foreign.body.error.code).toBe(missing.body.error.code);
    const own = await call('GET', '/api/v1/org', { user: alice, org: orgA });
    expect(own.status).toBe(200); expect(own.body.data.id).toBe(orgA);
  });
  it('PATCH /org: admin may rename (audited); agent may not; unknown/forbidden fields rejected', async () => {
    expect((await call('PATCH', '/api/v1/org', { user: agent, org: orgA, body: { name: 'x' } })).status).toBe(403);
    expect((await call('PATCH', '/api/v1/org', { user: admin, org: orgA, body: { name: 'Renamed', data_retention_days: 120 } })).status).toBe(200);
    expect((await call('GET', '/api/v1/org', { user: viewer, org: orgA })).body.data).toMatchObject({ name: 'Renamed', data_retention_days: 120 });
    expect((await sql(`select 1 from audit_logs where org_id=$1 and action='org.update'`, [orgA])).length).toBe(1);
    for (const body of [{ slug: 'hijack' }, { kill_switch: true }, {}, { data_retention_days: 5 }, { name: '' }]) expect((await call('PATCH', '/api/v1/org', { user: admin, org: orgA, body })).status).toBe(422);
  });
  it('members: RLS shows viewers only themselves, admins everyone', async () => {
    expect((await call('GET', '/api/v1/org/members', { user: viewer, org: orgA })).body.data).toHaveLength(1);
    expect((await call('GET', '/api/v1/org/members', { user: admin, org: orgA })).body.data).toHaveLength(4);
  });
});

describe('tenant isolation and privilege escalation over HTTP', () => {
  it('alice cannot act on org B with any header/ID combination', async () => {
    const [bm] = await sql<{ id: string }>('select id from memberships where org_id=$1', [orgB]);
    expect((await call('PATCH', `/api/v1/org/members/${bm.id}`, { user: alice, org: orgB, body: { role: 'viewer' } })).status).toBe(404);   // not a member of B
    expect((await call('PATCH', `/api/v1/org/members/${bm.id}`, { user: alice, org: orgA, body: { role: 'viewer' } })).status).toBe(403);   // A header, B member id
    expect((await call('DELETE', `/api/v1/org/members/${bm.id}`, { user: alice, org: orgA })).status).toBe(403);
    expect((await call('POST', '/api/v1/org/invitations', { user: alice, org: orgB, body: { email: 'x@example.com', role: 'agent' } })).status).toBe(404);
    const bInv = await invite(orgB, bob, `b-${uniq()}@example.com`);
    const [row] = await sql<{ id: string }>('select id from invitations where org_id=$1 order by created_at desc limit 1', [orgB]);
    expect((await call('POST', `/api/v1/org/invitations/${row.id}/revoke`, { user: alice, org: orgA })).status).toBe(403);
    expect((await call('POST', `/api/v1/org/invitations/${row.id}/resend`, { user: alice, org: orgA })).status).toBe(403);
    expect(bInv.status).toBe(201); expect((await sql(`select status from invitations where id=$1`, [row.id]))[0]).toEqual({ status: 'pending' });
    expect((await call('GET', '/api/v1/org/invitations', { user: alice, org: orgA })).body.data.every((i: { id: string }) => i.id !== row.id)).toBe(true);
    expect((await sql('select name from organizations where id=$1', [orgB]))[0]).toEqual({ name: 'Org' });
  });
  it('role matrix: agent/viewer cannot invite or manage; admin cannot create admins or touch owner', async () => {
    const [ms] = await sql<{ id: string }>('select id from memberships where org_id=$1 and user_id=$2', [orgA, agent.id]);
    const [mo] = await sql<{ id: string }>('select id from memberships where org_id=$1 and user_id=$2', [orgA, alice.id]);
    for (const u of [agent, viewer]) {
      expect((await invite(orgA, u, `z-${uniq()}@example.com`)).status).toBe(403);
      expect((await call('GET', '/api/v1/org/invitations', { user: u, org: orgA })).status).toBe(403);
      expect((await call('PATCH', `/api/v1/org/members/${ms.id}`, { user: u, org: orgA, body: { role: 'admin' } })).status).toBe(403);
    }
    expect((await invite(orgA, admin, `a2-${uniq()}@example.com`, 'admin')).status).toBe(403);
    expect((await call('PATCH', `/api/v1/org/members/${ms.id}`, { user: admin, org: orgA, body: { role: 'admin' } })).status).toBe(403);
    expect((await call('PATCH', `/api/v1/org/members/${mo.id}`, { user: admin, org: orgA, body: { role: 'viewer' } })).status).toBe(403);
    expect((await call('PATCH', `/api/v1/org/members/${ms.id}`, { user: alice, org: orgA, body: { role: 'owner' } })).status).toBe(422);
    expect((await call('DELETE', `/api/v1/org/members/${mo.id}`, { user: admin, org: orgA })).status).toBe(403);
  });
});

describe('invitation flow', () => {
  it('create -> list hides token -> accept -> reuse blocked; uniform invalid response', async () => {
    const u = await mkUser('invitee'); const inv = await invite(orgA, alice, u.email, 'viewer');
    expect(inv.status).toBe(201); expect(inv.headers.get('cache-control')).toBe('no-store');
    const token = tokenOf(inv.body.data.accept_url);
    const list = await call('GET', '/api/v1/org/invitations', { user: alice, org: orgA });
    expect(list.text).not.toContain(token); expect(JSON.stringify(list.body)).not.toMatch(/token/i);
    expect((await sql(`select 1 from invitations i where i::text like '%'||$1||'%'`, [token])).length).toBe(0);
    const ok = await call('POST', '/api/v1/invitations/accept', { user: u, body: { token } });
    expect(ok.status).toBe(200); expect(ok.body.data).toEqual({ org_id: orgA, role: 'viewer' });
    const reuse = await call('POST', '/api/v1/invitations/accept', { user: u, body: { token } });
    const junk = await call('POST', '/api/v1/invitations/accept', { user: u, body: { token: 'x'.repeat(43) } });
    expect([reuse.status, junk.status]).toEqual([404, 404]); expect(reuse.body.error.code).toBe('invitation_invalid'); expect(junk.body.error.code).toBe('invitation_invalid');
    expect((await sql(`select action from audit_logs where org_id=$1 and action like 'invitation.%'`, [orgA])).length).toBeGreaterThanOrEqual(4);
  });
  it('concurrent HTTP accepts: exactly one succeeds', async () => {
    const u = await mkUser('conc'); const inv = await invite(orgA, alice, u.email); const token = tokenOf(inv.body.data.accept_url);
    const rs = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/v1/invitations/accept', { user: u, body: { token } })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1); expect(rs.filter((r) => r.status === 404)).toHaveLength(5);
    expect((await sql('select 1 from memberships where org_id=$1 and user_id=$2', [orgA, u.id])).length).toBe(1);
  });
  it('wrong user -> 403 email_mismatch (invitation survives); unverified email -> 403; expired and revoked -> 404', async () => {
    const u = await mkUser('right'); const wrong = await mkUser('wrong'); const unv = await mkUser('unverified', false);
    const t1 = tokenOf((await invite(orgA, alice, u.email)).body.data.accept_url);
    expect((await call('POST', '/api/v1/invitations/accept', { user: wrong, body: { token: t1 } })).body.error.code).toBe('email_mismatch');
    expect((await call('POST', '/api/v1/invitations/accept', { user: u, body: { token: t1 } })).status).toBe(200);
    const t2 = tokenOf((await invite(orgA, alice, unv.email)).body.data.accept_url);
    expect((await call('POST', '/api/v1/invitations/accept', { user: unv, body: { token: t2 } })).status).toBe(403);
    const e = await mkUser('expired'); const t3 = tokenOf((await invite(orgA, alice, e.email)).body.data.accept_url);
    await sql(`update invitations set expires_at = now() - interval '1 second' where email=$1`, [e.email]);
    expect((await call('POST', '/api/v1/invitations/accept', { user: e, body: { token: t3 } })).status).toBe(404);
    const r = await mkUser('revoked'); const ir = await invite(orgA, alice, r.email);
    expect((await call('POST', `/api/v1/org/invitations/${ir.body.data.id}/revoke`, { user: alice, org: orgA })).status).toBe(200);
    expect((await call('POST', `/api/v1/org/invitations/${ir.body.data.id}/revoke`, { user: alice, org: orgA })).status).toBe(409);
    expect((await call('POST', '/api/v1/invitations/accept', { user: r, body: { token: tokenOf(ir.body.data.accept_url) } })).status).toBe(404);
  });
  it('resend re-issues the token (old one dies); duplicate pending invite -> 409; invalid input -> 422', async () => {
    const u = await mkUser('resend'); const i1 = await invite(orgA, alice, u.email); const old = tokenOf(i1.body.data.accept_url);
    expect((await invite(orgA, alice, u.email)).status).toBe(409);
    const rs = await call('POST', `/api/v1/org/invitations/${i1.body.data.id}/resend`, { user: alice, org: orgA });
    expect(rs.status).toBe(200); const fresh = tokenOf(rs.body.data.accept_url); expect(fresh).not.toBe(old);
    expect((await call('POST', '/api/v1/invitations/accept', { user: u, body: { token: old } })).status).toBe(404);
    expect((await call('POST', '/api/v1/invitations/accept', { user: u, body: { token: fresh } })).status).toBe(200);
    for (const body of [{ email: 'nope', role: 'agent' }, { email: 'a@b.co', role: 'owner' }, { email: 'a@b.co' }, {}])
      expect((await call('POST', '/api/v1/org/invitations', { user: alice, org: orgA, body })).status).toBe(422);
    expect((await call('POST', '/api/v1/org/invitations/not-a-uuid/revoke', { user: alice, org: orgA })).status).toBe(422);
  });
  it('existing member cannot be invited (409)', async () => {
    expect((await invite(orgA, alice, agent.email)).status).toBe(409);
  });
});

describe('rate limiting', () => {
  it('org invite limit is enforced atomically under concurrency (20/h): exactly 20 succeed, rest 429 + Retry-After', async () => {
    const o = await mkUser('rl-owner'); const org = await mkOrg(o);
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => invite(org, o, `rl${i}-${uniq()}@example.com`)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(20);
    const limited = rs.filter((r) => r.status === 429);
    expect(limited).toHaveLength(10); expect(Number(limited[0].headers.get('retry-after'))).toBeGreaterThan(0); expect(limited[0].body.error.code).toBe('rate_limited');
  });
  it('accept-invitation limit is per user (10/h) and guessing is throttled', async () => {
    const u = await mkUser('guesser');
    const rs = await Promise.all(Array.from({ length: 14 }, () => call('POST', '/api/v1/invitations/accept', { user: u, body: { token: `${uniq()}${'g'.repeat(30)}` } })));
    expect(rs.filter((r) => r.status === 404)).toHaveLength(10); expect(rs.filter((r) => r.status === 429)).toHaveLength(4);
  });
  it('different users are limited independently (no shared bucket bypass via other identities)', async () => {
    const [a, b] = await Promise.all([mkUser('ind-a'), mkUser('ind-b')]);
    for (let i = 0; i < 10; i++) await call('POST', '/api/v1/invitations/accept', { user: a, body: { token: `${uniq()}${'h'.repeat(30)}` } });
    expect((await call('POST', '/api/v1/invitations/accept', { user: a, body: { token: 'z'.repeat(40) } })).status).toBe(429);
    expect((await call('POST', '/api/v1/invitations/accept', { user: b, body: { token: 'z'.repeat(40) } })).status).toBe(404);
  });
  it('spoofing X-Forwarded-For cannot bypass the per-user limit; org-create is limited to 5/h per user', async () => {
    const u = await mkUser('spoofer');
    const rs = [];
    for (let i = 0; i < 12; i++) rs.push(await call('POST', '/api/v1/invitations/accept', { user: u, body: { token: `${uniq()}${'s'.repeat(30)}` }, headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.${i}` } }));
    expect(rs.filter((r) => r.status === 429).length).toBe(2);                      // rotating the header changed nothing: still 10/h for this user
    const c = await mkUser('creator5'); const out = [];
    for (let i = 0; i < 7; i++) out.push((await call('POST', '/api/v1/orgs', { user: c, body: { name: 'N', slug: `c5-${uniq()}` } })).status);
    expect(out).toEqual([201, 201, 201, 201, 201, 429, 429]);
  });
  it('limiter outage: public-facing accept fails CLOSED (429), authenticated org-create fails OPEN', async () => {
    await sql('revoke execute on function public.rate_limit_hit(text,int,int) from service_role');
    try {
      const u = await mkUser('outage');
      expect((await call('POST', '/api/v1/invitations/accept', { user: u, body: { token: 'q'.repeat(40) } })).status).toBe(429);
      expect((await call('POST', '/api/v1/orgs', { user: u, body: { name: 'Open', slug: `open-${uniq()}` } })).status).toBe(201);
    } finally { await sql('grant execute on function public.rate_limit_hit(text,int,int) to service_role'); }
  });
});

describe('internal job runner', () => {
  const run = (secret?: string) => call('POST', '/api/internal/jobs/run', { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  it('requires the cron secret', async () => {
    expect((await run()).status).toBe(401); expect((await run('wrong')).status).toBe(401); expect((await run(process.env.CRON_SECRET!.slice(0, -1))).status).toBe(401);
    expect((await call('POST', '/api/internal/jobs/run', { user: alice })).status).toBe(401);          // a user JWT is not a cron credential
    const ok = await run(process.env.CRON_SECRET); expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ claimed: expect.any(Number), done: 0, maintenance: expect.any(Object) });
  });
  it('unknown job type fails as non-retryable -> dead + audit; crashed-worker job is recovered then dies', async () => {
    const [j] = await sql<{ id: string }>(`insert into jobs(org_id,type,dedupe_key) values ($1,'nope',$2) returning id`, [orgA, uniq()]);
    await sql(`select * from claim_jobs('crashed-worker', 100000)`).catch(() => {});                          // "crashes" while holding the lease
    expect((await sql<{ status: string; attempts: number }>('select status, attempts from jobs where id=$1', [j.id]))[0]).toEqual({ status: 'running', attempts: 1 });
    await sql(`update jobs set locked_until = now() - interval '1 second' where id=$1`, [j.id]);
    const r = await run(process.env.CRON_SECRET); expect(r.status).toBe(200); expect(r.body.data.dead).toBeGreaterThanOrEqual(1);
    expect((await sql<{ status: string; attempts: number }>('select status, attempts from jobs where id=$1', [j.id]))[0]).toEqual({ status: 'dead', attempts: 2 });
    expect((await sql(`select 1 from audit_logs where org_id=$1 and action='job.dead' and target_id=$2`, [orgA, j.id])).length).toBe(1);
  });
  it('runs maintenance: expires stale invitations', async () => {
    const u = await mkUser('stale'); await invite(orgA, alice, u.email);
    await sql(`update invitations set expires_at = now() - interval '1 hour' where email=$1`, [u.email]);
    await run(process.env.CRON_SECRET);
    expect((await sql(`select status from invitations where email=$1`, [u.email]))[0]).toEqual({ status: 'expired' });
  });
});

describe('error handling and information exposure', () => {
  it('internal failures return a generic 500 with request id and no internals', async () => {
    const u = await mkUser('boom');
    const r = await call('POST', '/api/v1/orgs', { user: u, raw: '{"name":"a\\u0000b","slug":"boom-slug-1"}' });  // NUL char: Postgres rejects with an unmapped code
    expect([422, 500]).toContain(r.status);
    for (const leak of [/postgres/i, /pgrst/i, /stack/i, /\.ts:\d+/, /node_modules/, /supabase/i, /relation|column|syntax error/i]) expect(r.text).not.toMatch(leak);
    expect(r.body.error.request_id).toBe(r.headers.get('x-request-id'));
  });
  it('404/405 on unknown routes do not leak framework details', async () => {
    const r = await call('GET', '/api/v1/does-not-exist'); expect(r.status).toBe(404); expect(r.text).not.toMatch(/next\.js|stack/i);
    expect((await call('DELETE', '/api/v1/health')).status).toBe(405);
  });
});

describe('CSRF / Origin and session cookies', () => {
  const cookie = (u: TUser) => `sb-127-auth-token=base64-${Buffer.from(JSON.stringify({ access_token: u.token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u.id } })).toString('base64url')}`;
  it('cookie-authenticated mutation without/with foreign Origin is rejected (403); Bearer is exempt', async () => {
    const body = { name: 'Csrf', slug: `csrf-${uniq()}` };
    expect((await call('POST', '/api/v1/orgs', { headers: { cookie: cookie(alice) }, body })).status).toBe(403);
    expect((await call('POST', '/api/v1/orgs', { headers: { cookie: cookie(alice), origin: 'https://evil.example' }, body })).status).toBe(403);
    expect((await call('POST', '/api/v1/orgs', { headers: { cookie: cookie(alice), 'sec-fetch-site': 'cross-site' }, body })).status).toBe(403);
    expect((await call('POST', '/api/v1/orgs', { user: alice, headers: { origin: 'https://evil.example' }, body })).status).toBe(201);
  });
  it('cookie session works for same-origin requests', async () => {
    const r = await call('GET', '/api/v1/org', { headers: { cookie: cookie(alice) }, org: orgA });
    expect(r.status).toBe(200);
    const w = await call('POST', '/api/v1/orgs', { headers: { cookie: cookie(alice), origin: BASE }, body: { name: 'Same', slug: `same-${uniq()}` } });
    expect(w.status).toBe(201);
  });
});

describe('pages and bundles', () => {
  it('/dashboard without a session redirects to /login before rendering anything', async () => {
    const r = await fetch(`${BASE}/dashboard`, { redirect: 'manual' });
    expect(r.status).toBe(307); expect(r.headers.get('location')).toContain('/login?next=%2Fdashboard');
    expect(await r.text()).not.toMatch(/대시보드|내 조직/);
  });
  it('/login renders an accessible form with security headers', async () => {
    const r = await fetch(`${BASE}/login`); const html = await r.text();
    expect(r.status).toBe(200); expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(html).toMatch(/<label[^>]*for="email"/); expect(html).toMatch(/<label[^>]*for="password"/); expect(html).toMatch(/aria-live="polite"/);
  });
  it('service-role key and server env names never appear in any client asset', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const files = walk(process.env.STATIC_DIR!); expect(files.length).toBeGreaterThan(0);
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const secret of [process.env.SERVICE_KEY!, 'SUPABASE_SERVICE_ROLE_KEY', 'SECRETS_MASTER_KEY', 'CRON_SECRET', process.env.JWT_SECRET!]) expect(all).not.toContain(secret);
  });
});

const withAal2 = async (u: TUser): Promise<TUser> => ({ ...u, token: process.env.REAL_SUPABASE === '1' ? (await upgradeToAal2(u.token)).token : mintJwt(u.id, { aal: 'aal2' }) });

describe('MFA for owner/admin over HTTP', () => {
  it('owner/admin sessions without MFA get 403 mfa_required on org endpoints; aal2 sessions work; sign-in-level actions need no MFA', async () => {
    const o = await mkUser('mfa-o', true, { aal: 'aal1' });
    const created = await call('POST', '/api/v1/orgs', { user: o, body: { name: 'M', slug: `mfa-${uniq()}` } });
    expect(created.status).toBe(201);                                            // creating an org needs no MFA
    const org = created.body.data.id;
    for (const [m, path, body] of [['GET', '/api/v1/org'], ['PATCH', '/api/v1/org', { name: 'x' }], ['GET', '/api/v1/org/members'], ['POST', '/api/v1/org/invitations', { email: 'a@example.com', role: 'agent' }], ['GET', '/api/v1/org/invitations']] as [string, string, unknown?][]) {
      const r = await call(m, path, { user: o, org, body });
      expect([r.status, r.body.error.code], `${m} ${path}`).toEqual([403, 'mfa_required']);
    }
    const o2 = await withAal2(o);
    expect((await call('GET', '/api/v1/org', { user: o2, org })).status).toBe(200);
    expect((await invite(org, o2, `m-${uniq()}@example.com`)).status).toBe(201);
    expect((await call('GET', '/api/v1/org', { user: o, org })).status).toBe(403);   // the old aal1 token stays aal1
  });
  it('an admin member without MFA is blocked, an agent member without MFA is not', async () => {
    const adm = await mkUser('mfa-adm', true, { aal: 'aal1' }); const ag = await mkUser('mfa-ag', true, { aal: 'aal1' });
    const own = await mkUser('mfa-own'); const orgM = await mkOrg(own);            // fresh org: orgA's invite quota is used up by earlier tests
    const [adm2, ag2] = [await withAal2(adm), await withAal2(ag)];                 // join with MFA-capable sessions (acceptance itself needs no MFA)
    await addMember(orgM, own, adm2, 'admin'); await addMember(orgM, own, ag2, 'agent');
    expect((await call('GET', '/api/v1/org', { user: adm, org: orgM })).body.error.code).toBe('mfa_required');
    expect((await call('POST', '/api/v1/org/invitations', { user: adm, org: orgM, body: { email: `n-${uniq()}@example.com`, role: 'viewer' } })).status).toBe(403);
    expect((await call('GET', '/api/v1/org', { user: ag, org: orgM })).status).toBe(200);   // agents never need MFA
    expect((await call('GET', '/api/v1/org', { user: adm2, org: orgM })).status).toBe(200);
  });
});

describe('security headers over HTTP', () => {
  const csp = (r: Response) => r.headers.get('content-security-policy')!;
  it('pages carry a per-request nonce CSP that matches the nonce on the page scripts', async () => {
    const [a, b] = await Promise.all([fetch(`${BASE}/login`), fetch(`${BASE}/login`)]);
    const na = csp(a).match(/'nonce-([^']+)'/)![1], nb = csp(b).match(/'nonce-([^']+)'/)![1];
    expect(na).not.toBe(nb);
    const html = await a.text(); expect(html).toContain(`nonce="${na}"`);
    expect(csp(a)).not.toMatch(/unsafe-inline|unsafe-eval/); expect(csp(a)).toContain("frame-ancestors 'none'");
    expect(a.headers.get('permissions-policy')).toContain('camera=()'); expect(a.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(a.headers.get('strict-transport-security')).toBeNull();                 // APP_URL is http in tests: HSTS must not be sent
  });
  it('home page is dynamic too (nonce applied), redirects and API responses carry headers', async () => {
    const home = await fetch(`${BASE}/`); expect(csp(home)).toContain("'strict-dynamic'"); expect(await home.text()).toMatch(/nonce="/);
    const redirect = await fetch(`${BASE}/dashboard`, { redirect: 'manual' }); expect(redirect.status).toBe(307); expect(csp(redirect)).toContain("default-src 'self'");
    const api = await fetch(`${BASE}/api/v1/health`); expect(csp(api)).toBe("default-src 'none'; frame-ancestors 'none'"); expect(api.headers.get('x-content-type-options')).toBe('nosniff');
    const err = await fetch(`${BASE}/api/v1/org`); expect(err.status).toBe(401); expect(csp(err)).toContain("default-src 'none'");
  });
});

describe('server log hygiene (runs last)', () => {
  it('server log contains no service key, JWTs, invitation tokens or e-mail addresses', async () => {
    const log = readFileSync(process.env.NEXT_LOG!, 'utf8');
    const tokens = (await sql<{ n: number }>('select 1 n')).length && [alice, bob, admin, agent, viewer].map((u) => u.token);
    for (const needle of [process.env.SERVICE_KEY!, process.env.JWT_SECRET!, process.env.CRON_SECRET!, ...(tokens || [])]) expect(log).not.toContain(needle);
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    expect(log).not.toMatch(/@example\.com/);
  });
});
