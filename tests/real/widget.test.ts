import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addMember, BASE, call, mkOrg, mkUser, pool, uniq } from '../api/helpers';

// REAL local Supabase + Next server. Embedded web chat widget: API, SSE, isolation, identity verification. Run via scripts/test-supabase.sh.
const SB = process.env.SUPABASE_URL!; const ORIGIN = 'https://shop.example';
const rip = () => ({ 'x-forwarded-for': `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const chat = (method: string, path: string, o: { token?: string; origin?: string | null; body?: unknown } = {}) =>
  fetch(`${BASE}/api/v1/chat${path}`, { method, headers: { ...rip(), 'content-type': 'application/json', ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
const vid = () => `vis-${uniq()}${uniq()}`; const cid = () => `msg-${uniq()}${uniq()}`;
async function widget(extra: object = {}) {
  const owner = await mkUser('ww'); const org = await mkOrg(owner);
  const r = await call('POST', '/api/v1/channels', { user: owner, org, body: { kind: 'web_chat', name: 'Widget', allowed_origins: [ORIGIN], title: 'Shop help', greeting: 'Hi!', color: '#112233', ...extra } });
  expect(r.status, r.text).toBe(201);
  return { owner, org, id: r.body.data.id as string, key: r.body.data.public_key as string, secret: r.body.data.identity_secret as string };
}
const start = (key: string, extra: object = {}, origin: string | null = ORIGIN) => chat('POST', '/sessions', { origin, body: { public_key: key, visitor_id: vid(), ...extra } });
const convOf = async (w: { owner: Awaited<ReturnType<typeof mkUser>>; org: string }) => (await call('GET', '/api/v1/conversations', { user: w.owner, org: w.org })).body.data as { id: string; customer: { email: string | null; display_name: string } }[];
const agentReply = (w: { owner: Awaited<ReturnType<typeof mkUser>>; org: string }, conv: string, body: string, internal = false) => call('POST', `/api/v1/conversations/${conv}/messages`, { user: w.owner, org: w.org, body: { body, client_id: crypto.randomUUID(), internal } });

interface Ev { id?: string; event: string; data: string }
async function sse(token: string, o: { origin?: string; after?: string; lastEventId?: string; maxS?: number; during?: () => Promise<unknown> } = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15_000);
  const r = await fetch(`${BASE}/api/v1/chat/stream?max_s=${o.maxS ?? 3}${o.after ? `&after=${encodeURIComponent(o.after)}` : ''}`, { headers: { ...rip(), origin: o.origin ?? ORIGIN, authorization: `Bearer ${token}`, ...(o.lastEventId ? { 'last-event-id': o.lastEventId } : {}) }, signal: ac.signal });
  if (!r.ok) { clearTimeout(t); return { status: r.status, events: [] as Ev[], headers: r.headers }; }
  const during = o.during?.(); let buf = ''; const dec = new TextDecoder();
  for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) buf += dec.decode(c, { stream: true });
  clearTimeout(t); await during;
  const events = buf.split('\n\n').filter((b) => b.trim() && !b.startsWith('retry:') && !b.startsWith(':')).map((b) => { const e: Ev = { event: 'message', data: '' }; for (const l of b.split('\n')) { if (l.startsWith('event: ')) e.event = l.slice(7); else if (l.startsWith('data: ')) e.data += l.slice(6); else if (l.startsWith('id: ')) e.id = l.slice(4); } return e; });
  return { status: r.status, events, headers: r.headers };
}
const msgs = (e: Ev[]) => e.filter((x) => x.event === 'message').map((x) => JSON.parse(x.data) as { id: string; direction: string; body: string });

describe('keys, config and admin separation', () => {
  it('the public key / visitor token cannot reach any admin or agent API', async () => {
    const w = await widget(); const s = await start(w.key); const tok = s.body.data.token as string;
    for (const bearer of [w.key, tok, 'x'.repeat(43)]) for (const path of ['/api/v1/channels', '/api/v1/conversations', '/api/v1/org', '/api/v1/org/members']) {
      const r = await call('GET', path, { user: { token: bearer }, org: w.org }); expect(r.status, `${path}`).toBe(401);
    }
    expect((await call('POST', '/api/v1/conversations', { headers: { 'x-org-id': w.org, 'x-public-key': w.key } })).status).toBeGreaterThanOrEqual(401);
    expect((await chat('GET', '/messages', { token: w.key })).status).toBe(401);                                        // a key is not a session token
    expect((await fetch(`${SB}/rest/v1/chat_sessions?select=id`, { headers: { apikey: process.env.ANON_KEY!, authorization: `Bearer ${process.env.ANON_KEY!}` } })).status).toBeGreaterThanOrEqual(401);
  });
  it('config is public only for an allowed origin and exposes cosmetics only (no secrets, org or ids)', async () => {
    const w = await widget();
    const ok = await chat('GET', `/config?public_key=${w.key}`); expect(ok.body.data).toEqual({ api: 1, title: 'Shop help', greeting: 'Hi!', color: '#112233' });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect((await chat('GET', `/config?public_key=${w.key}`, { origin: 'https://evil.example' })).status).toBe(404);
    expect((await chat('GET', `/config?public_key=${w.key}`, { origin: null })).status).toBe(404);
    expect((await chat('GET', '/config?public_key=nope')).status).toBe(404);
    expect(JSON.stringify(ok.body)).not.toMatch(new RegExp(`${w.org}|${w.secret}|integration|org_id`));
  });
  it('widget is served as a cacheable static script', async () => {
    const r = await fetch(`${BASE}/widget.js`); const t = await r.text();
    expect([r.status, r.headers.get('content-type')]).toEqual([200, expect.stringContaining('javascript')]); expect(r.headers.get('cache-control')).toContain('max-age'); expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(t).toContain('data-key');
  });
  it('widget source never parses HTML or evaluates code (XSS-by-construction) and uses no cookies', () => {
    const src = readFileSync('public/widget.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /srcdoc/, /document\.cookie/, /postMessage/, /localStorage\.setItem\([^)]*token/]) expect(src, String(bad)).not.toMatch(bad);
    expect(src).toContain("credentials: 'omit'");
  });
});

describe('widget management', () => {
  it('admins update origins/cosmetics (audited, validated); removing an origin or pausing kills existing sessions at once', async () => {
    const w = await widget(); const agent = await mkUser('wa', true, { aal: 'aal1' }); await addMember(w.org, w.owner, agent, 'agent');
    const s = await start(w.key); const tok = s.body.data.token as string;
    expect((await chat('GET', '/messages', { token: tok })).status).toBe(200);
    expect((await call('PATCH', `/api/v1/channels/${w.id}`, { user: agent, org: w.org, body: { widget: { title: 'x' } } })).status).toBe(403);
    for (const widget of [{ allowed_origins: ['https://x.example/path'] }, { allowed_origins: ['javascript:alert(1)'] }, { color: 'red' }, { title: 'x'.repeat(41) }, { allowed_origins: [] }, { evil: 1 }])
      expect((await call('PATCH', `/api/v1/channels/${w.id}`, { user: w.owner, org: w.org, body: { widget } })).status, JSON.stringify(widget)).toBe(422);
    expect((await call('PATCH', `/api/v1/channels/${w.id}`, { user: w.owner, org: w.org, body: { name: 'Renamed', widget: { allowed_origins: [ORIGIN, 'https://b.example'], title: 'New', color: '#abcdef' } } })).status).toBe(200);
    expect((await chat('GET', `/config?public_key=${w.key}`, { origin: 'https://b.example' })).body.data).toMatchObject({ title: 'New', color: '#abcdef' });
    expect((await chat('GET', '/messages', { token: tok })).status).toBe(200);
    await call('PATCH', `/api/v1/channels/${w.id}`, { user: w.owner, org: w.org, body: { widget: { allowed_origins: ['https://b.example'] } } });   // ORIGIN removed
    expect((await chat('GET', '/messages', { token: tok })).status).toBe(401);
    expect((await start(w.key)).status).toBe(403);
    await call('PATCH', `/api/v1/channels/${w.id}`, { user: w.owner, org: w.org, body: { widget: { allowed_origins: [ORIGIN] } } });
    const s2 = await start(w.key); expect(s2.status).toBe(201);
    await call('PATCH', `/api/v1/channels/${w.id}`, { user: w.owner, org: w.org, body: { status: 'paused' } });
    expect([(await chat('GET', '/messages', { token: s2.body.data.token })).status, (await start(w.key)).status, (await chat('GET', `/config?public_key=${w.key}`)).status]).toEqual([401, 403, 404]);
    expect((await pool.query("select count(*)::int n from audit_logs where org_id=$1 and action='channel.update' and metadata->>'fields'='widget'", [w.org])).rows[0].n).toBe(3);
  });
  it('another org cannot touch or rotate this widget', async () => {
    const a = await widget(); const b = await widget();
    expect((await call('PATCH', `/api/v1/channels/${a.id}`, { user: b.owner, org: b.org, body: { widget: { title: 'hijack' } } })).status).toBe(404);
    expect((await call('PATCH', `/api/v1/channels/${a.id}`, { user: b.owner, org: a.org, body: { status: 'paused' } })).status).toBe(404);
    expect((await call('POST', `/api/v1/channels/${a.id}/rotate-secret`, { user: b.owner, org: b.org })).status).toBe(404);
    expect((await chat('GET', `/config?public_key=${a.key}`)).body.data.title).toBe('Shop help');
  });
});

describe('identity verification (public key vs secret key)', () => {
  const hash = (secret: string, email: string) => createHmac('sha256', secret).update(email).digest('hex');
  it('a valid HMAC from the customer\'s server identifies the visitor; anything else is refused (never downgraded)', async () => {
    const w = await widget(); const email = `vip-${uniq()}@example.com`;
    const s = await start(w.key, { email, email_hash: hash(w.secret, email), name: 'VIP Kim' }); expect(s.status).toBe(201);
    await chat('POST', '/messages', { token: s.body.data.token, body: { body: 'verified hello', client_id: cid() } });
    const c = await convOf(w); expect(c).toHaveLength(1); expect(c[0].customer).toMatchObject({ email, display_name: 'VIP Kim' });
    expect((await pool.query("select kind from customer_identities where org_id=$1", [w.org])).rows).toEqual([{ kind: 'email' }]);
    expect((await pool.query("select verified_email from chat_sessions where org_id=$1", [w.org])).rows[0].verified_email).toBe(email);
    for (const body of [{ email, email_hash: hash(w.secret, 'other@example.com') }, { email, email_hash: hash('wrong-secret', email) }, { email, email_hash: '0'.repeat(64) }, { email: 'MALLORY@example.com', email_hash: hash(w.secret, email) }])
      expect((await start(w.key, body)).status).toBe(403);
    expect((await start(w.key, { email })).status).toBe(422); expect((await start(w.key, { email_hash: hash(w.secret, email) })).status).toBe(422);
    expect((await convOf(w)).length).toBe(1);                                                                           // refused attempts created nothing
    const other = await widget(); expect((await start(other.key, { email, email_hash: hash(w.secret, email) })).status).toBe(403);   // another widget's secret is useless here
  });
  it('rotating the secret kills the old one immediately; the new one is audited and shown once', async () => {
    const w = await widget(); const email = `rot-${uniq()}@example.com`;
    const r = await call('POST', `/api/v1/channels/${w.id}/rotate-secret`, { user: w.owner, org: w.org }); expect(r.status).toBe(200);
    const fresh = r.body.data.identity_secret as string; expect(fresh).not.toBe(w.secret);
    expect((await start(w.key, { email, email_hash: hash(w.secret, email) })).status).toBe(403);
    expect((await start(w.key, { email, email_hash: hash(fresh, email) })).status).toBe(201);
    expect((await call('GET', '/api/v1/channels', { user: w.owner, org: w.org })).text).not.toContain(fresh);
    expect((await pool.query("select encode(ciphertext,'escape') c from integration_secrets where org_id=$1", [w.org])).rows.join('')).not.toContain(fresh);
    expect((await pool.query("select 1 from audit_logs where org_id=$1 and action='channel.secret'", [w.org])).rowCount).toBe(1);
  });
  it('an unverified visitor can never claim someone else\'s e-mail identity', async () => {
    const w = await widget(); const real = `real-${uniq()}@example.com`; const ok = await start(w.key, { email: real, email_hash: hash(w.secret, real) });
    await chat('POST', '/messages', { token: ok.body.data.token, body: { body: 'secret order info', client_id: cid() } });
    const anon = await start(w.key, { name: real });                                                                  // just a display name
    await chat('POST', '/messages', { token: anon.body.data.token, body: { body: 'hi', client_id: cid() } });
    const feed = await chat('GET', '/messages', { token: anon.body.data.token }); expect(JSON.stringify(feed.body)).not.toContain('secret order info');
    expect((await pool.query("select count(distinct customer_id)::int n from conversations where org_id=$1", [w.org])).rows[0].n).toBe(2);
  });
});

describe('SSE delivery', () => {
  it('pushes agent replies while connected; internal notes and drafts are never sent; ids support resume without duplicates', async () => {
    const w = await widget(); const s = await start(w.key); const tok = s.body.data.token as string;
    await chat('POST', '/messages', { token: tok, body: { body: 'hello agent', client_id: cid() } });
    const conv = (await convOf(w))[0].id;
    const first = await sse(tok, { maxS: 4, during: async () => { await new Promise((r) => setTimeout(r, 800)); await agentReply(w, conv, 'NOTE-ONLY', true); await agentReply(w, conv, 'live reply one'); } });
    expect(first.headers.get('content-type')).toContain('text/event-stream'); expect(first.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(msgs(first.events).map((m) => m.body)).toEqual(['hello agent', 'live reply one']);
    expect(JSON.stringify(first.events)).not.toContain('NOTE-ONLY');
    const lastId = first.events.filter((e) => e.event === 'message').pop()!.id!;
    await agentReply(w, conv, 'reply two while offline');
    const resumed = await sse(tok, { lastEventId: lastId, maxS: 2 });
    const bodies = msgs(resumed.events).map((m) => m.body); expect(bodies).toContain('reply two while offline');
    const all = [...msgs(first.events), ...msgs(resumed.events)]; const seen = new Map<string, number>(); for (const m of all) seen.set(m.id, (seen.get(m.id) ?? 0) + 1);
    expect(new Set(all.map((m) => m.id)).size).toBe(3);                                                                // a client that dedupes by id shows exactly three bubbles
    expect(Array.from(seen.values()).every((n) => n <= 2)).toBe(true);                                                  // overlap at the cursor is bounded to the boundary message
    const poll = await chat('GET', `/messages?after=${encodeURIComponent(lastId)}`, { token: tok }); expect(poll.body.data.map((m: { body: string }) => m.body)).toContain('reply two while offline');   // polling fallback shows the same data
  });
  it('the stream ends by itself at max_s so the client can reconnect (serverless limit)', async () => {
    const w = await widget(); const s = await start(w.key); const t0 = Date.now();
    const r = await sse(s.body.data.token, { maxS: 2 }); expect(Date.now() - t0).toBeLessThan(8000); expect(r.status).toBe(200);
  });
  it('agent end-chat: the open stream receives `closed`, the token dies, the conversation is closed and audited', async () => {
    const w = await widget(); const s = await start(w.key); const tok = s.body.data.token as string;
    await chat('POST', '/messages', { token: tok, body: { body: 'bye soon', client_id: cid() } }); const conv = (await convOf(w))[0].id;
    const detail = async () => (await call('GET', `/api/v1/conversations/${conv}`, { user: w.owner, org: w.org })).body.data;
    expect((await detail()).chat).toEqual({ online: true, ended: false });
    const viewer = await mkUser('wv', true, { aal: 'aal1' }); await addMember(w.org, w.owner, viewer, 'viewer');
    expect((await call('POST', `/api/v1/conversations/${conv}/end-chat`, { user: viewer, org: w.org })).status).toBe(403);
    const stranger = await mkUser('wx'); const o2 = await mkOrg(stranger);
    expect((await call('POST', `/api/v1/conversations/${conv}/end-chat`, { user: stranger, org: o2 })).status).toBe(404);
    const r = await sse(tok, { maxS: 6, during: async () => { await new Promise((x) => setTimeout(x, 800)); expect((await call('POST', `/api/v1/conversations/${conv}/end-chat`, { user: w.owner, org: w.org })).body.data.revoked).toBe(1); } });
    expect(r.events.some((e) => e.event === 'closed')).toBe(true);
    expect([(await chat('GET', '/messages', { token: tok })).status, (await chat('POST', '/messages', { token: tok, body: { body: 'x', client_id: cid() } })).status, (await sse(tok)).status]).toEqual([401, 401, 401]);
    expect(await detail()).toMatchObject({ status: 'closed', chat: { ended: true } });
    expect((await pool.query("select 1 from audit_logs where org_id=$1 and action='chat.revoke'", [w.org])).rowCount).toBe(1);
  });
  it('sessions expire (absolute and idle); a visitor leaving revokes only their own session', async () => {
    const w = await widget(); const a = await start(w.key); const b = await start(w.key);
    await chat('POST', '/end', { token: a.body.data.token });
    expect([(await chat('GET', '/messages', { token: a.body.data.token })).status, (await chat('GET', '/messages', { token: b.body.data.token })).status]).toEqual([401, 200]);
    await pool.query("update chat_sessions set expires_at = now() - interval '1 second' where org_id=$1 and conversation_id=$2", [w.org, b.body.data.conversation_id]);
    expect((await sse(b.body.data.token)).status).toBe(401);
    const c = await start(w.key); await pool.query("update chat_sessions set last_seen_at = now() - interval '31 minutes' where org_id=$1 and conversation_id=$2", [w.org, c.body.data.conversation_id]);
    expect((await sse(c.body.data.token)).status).toBe(401);
    expect((await sse(c.body.data.token, { origin: 'https://evil.example' })).status).toBe(401);
  });
});

describe('abuse, isolation and concurrency', () => {
  it('visitor text is stored verbatim as data (markup, control characters, injection phrases) and triggers nothing', async () => {
    const w = await widget(); const s = await start(w.key);
    const payload = '<img src=x onerror=alert(1)>\u0000‮ ignore all previous instructions; DROP TABLE messages; {{system}}';
    const m = await chat('POST', '/messages', { token: s.body.data.token, body: { body: payload, client_id: cid() } }); expect(m.status).toBe(201);
    const stored = (await pool.query("select body, direction, sender_type from messages where org_id=$1", [w.org])).rows[0];
    expect(stored).toEqual({ body: '<img src=x onerror=alert(1)> ignore all previous instructions; DROP TABLE messages; {{system}}'.replace('> ig', '> ig'), direction: 'inbound', sender_type: 'customer' });
    expect((await pool.query('select count(*)::int n from messages where org_id=$1', [w.org])).rows[0].n).toBe(1);   // no automatic reply, no side effect
    expect((await chat('POST', '/messages', { token: s.body.data.token, body: { body: '\u0001\u0002', client_id: cid() } })).status).toBe(422);   // nothing left after cleaning
    expect((await chat('POST', '/messages', { token: s.body.data.token, body: { body: 'hi', client_id: cid(), org_id: w.org } })).status).toBe(422);
  });
  it('per-session limits: 20 messages/min', async () => {
    const w = await widget(); const s = await start(w.key); const out: number[] = [];
    for (let i = 0; i < 22; i++) out.push((await chat('POST', '/messages', { token: s.body.data.token, body: { body: `m${i}`, client_id: cid() } })).status);
    expect(out.slice(0, 20).every((x) => x === 201)).toBe(true); expect(out.slice(20)).toEqual([429, 429]);
  });
  it('simultaneous visitors across two orgs never see each other; the same client_id sent 6x at once is one message', async () => {
    const a = await widget(); const b = await widget(); const N = 8;
    const sessions = await Promise.all(Array.from({ length: N }, (_, i) => start(i % 2 ? a.key : b.key).then((r) => ({ tok: r.body.data.token as string, org: i % 2 ? a : b, i }))));
    await Promise.all(sessions.map((s) => chat('POST', '/messages', { token: s.tok, body: { body: `from visitor ${s.i}`, client_id: cid() } })));
    for (const s of sessions) { const f = await chat('GET', '/messages', { token: s.tok }); expect(f.body.data.map((m: { body: string }) => m.body)).toEqual([`from visitor ${s.i}`]); }
    expect([(await convOf(a)).length, (await convOf(b)).length]).toEqual([N / 2, N / 2]);
    const dup = cid(); const rs = await Promise.all(Array.from({ length: 6 }, () => chat('POST', '/messages', { token: sessions[0].tok, body: { body: 'double', client_id: dup } })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect((await chat('GET', '/messages', { token: sessions[0].tok })).body.data.filter((m: { body: string }) => m.body === 'double')).toHaveLength(1);
    expect(sessions.every((s) => s.org.org !== (s.org === a ? b : a).org)).toBe(true);
  });
  it('CORS: preflight is open (the token/origin checks are the gate); errors for a bad origin reveal nothing', async () => {
    const pre = await fetch(`${BASE}/api/v1/chat/messages`, { method: 'OPTIONS' }); expect(pre.status).toBe(204); expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    const w = await widget(); const bad = await start(w.key, {}, 'https://evil.example'); expect(bad.status).toBe(403); expect(JSON.stringify(bad.body)).not.toMatch(new RegExp(`${w.org}|Widget|shop`));
  });
  it('logs carry no visitor text, tokens or secrets', async () => {
    const w = await widget(); const s = await start(w.key); await chat('POST', '/messages', { token: s.body.data.token, body: { body: 'WIDGET-SENTINEL-4242', client_id: cid() } });
    const log = process.env.NEXT_LOG ? readFileSync(process.env.NEXT_LOG, 'utf8') : '';
    for (const x of ['WIDGET-SENTINEL-4242', s.body.data.token, w.secret]) expect(log).not.toContain(x);
  });
});
