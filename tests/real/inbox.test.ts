import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { addMember, BASE, call, mkOrg, mkUser, pool, uniq, type TUser } from '../api/helpers';
import { signBody } from '@/server/domain/email';

// REAL local Supabase + Next server. Run via scripts/test-supabase.sh.
const CRON = { authorization: 'Bearer test-cron-secret-value' };
const SB = process.env.SUPABASE_URL!;
const rip = () => ({ 'x-forwarded-for': `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const runJobs = async () => { for (let i = 0; i < 6; i++) { const r = await call('POST', '/api/internal/jobs/run', { headers: CRON }); if (!r.body?.data?.claimed) return; } };
const fastForward = (org: string) => pool.query("update jobs set run_at = now() where org_id=$1 and status in ('failed','queued')", [org]);

// scripted SMTP server: records DATA; `accept=false` answers 451 to RCPT
function fakeSmtp(port = 0) {
  const got: string[] = []; let accept = true;
  const srv: Server = createServer((s) => {
    let inData = false, buf = ''; s.on('error', () => undefined); s.write('220 t\r\n');
    s.on('data', (d) => { buf += d.toString(); for (;;) {
      if (inData) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) return; got.push(buf.slice(0, e)); buf = buf.slice(e + 5); inData = false; s.write('250 ok\r\n'); continue; }
      const i = buf.indexOf('\r\n'); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (line.startsWith('EHLO')) s.write('250 t\r\n'); else if (line.startsWith('RCPT')) s.write(accept ? '250 ok\r\n' : '451 try later\r\n'); else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') s.end('221 bye\r\n'); else s.write('250 ok\r\n');
    } });
  });
  return new Promise<{ srv: Server; port: number; got: string[]; setAccept(v: boolean): void }>((r) => srv.listen(port, '127.0.0.1', () => r({ srv, port: (srv.address() as { port: number }).port, got, setAccept: (v) => { accept = v; } })));
}
const freePort = async () => { const s = await fakeSmtp(); const p = s.port; await new Promise((r) => s.srv.close(r)); return p; };

async function setup(smtpUrl?: string) {
  const owner = await mkUser('io'); const org = await mkOrg(owner);
  const ch = await call('POST', '/api/v1/channels', { user: owner, org, body: { kind: 'email', name: 'Support', address: `support-${uniq()}@acme.test`, ...(smtpUrl ? { smtp_url: smtpUrl } : {}) } });
  expect(ch.status).toBe(201);
  return { owner, org, channel: ch.body.data.id as string, secret: ch.body.data.webhook_secret as string, address: '' };
}
const hook = (channel: string, secret: string, payload: unknown, o: { ts?: string; sign?: string; raw?: string } = {}) => {
  const raw = o.raw ?? JSON.stringify(payload); const ts = o.ts ?? String(Math.floor(Date.now() / 1000));
  return call('POST', `/api/v1/webhooks/email/${channel}`, { raw, headers: { ...rip(), 'x-signature-timestamp': ts, 'x-signature': signBody(o.sign ?? secret, ts, raw) } });
};
const mail = (id: string, extra: object = {}) => ({ message_id: `<${id}@mail.example>`, from: { email: `cust-${uniq()}@example.com`, name: 'Cust' }, subject: 'Where is my order?', text: 'Hello, my order is late.', ...extra });
const counts = async (org: string) => (await pool.query("select (select count(*)::int from webhook_events where org_id=$1) ev, (select count(*)::int from messages where org_id=$1) msg, (select count(*)::int from conversations where org_id=$1) conv, (select count(*)::int from customers where org_id=$1) cust", [org])).rows[0];

describe('channel accounts', () => {
  it('admin creates an email channel; the signing secret is shown once, stored encrypted, never listed; agents cannot manage channels', async () => {
    const s = await setup(); const agent = await mkUser('ag', true, { aal: 'aal1' }); await addMember(s.org, s.owner, agent, 'agent');
    const list = await call('GET', '/api/v1/channels', { user: s.owner, org: s.org });
    expect(list.text).not.toContain(s.secret); expect(list.body.data[0]).toMatchObject({ kind: 'email', status: 'active' });
    const rows = await pool.query("select encode(ciphertext,'escape') c from integration_secrets where org_id=$1", [s.org]);
    expect(rows.rows.map((r) => r.c).join('')).not.toContain(s.secret);
    expect((await call('POST', '/api/v1/channels', { user: agent, org: s.org, body: { kind: 'email', name: 'x', address: 'x@y.co' } })).status).toBe(403);
    expect((await call('GET', '/api/v1/channels', { user: agent, org: s.org })).status).toBe(403);
    expect((await pool.query("select 1 from audit_logs where org_id=$1 and action='channel.create'", [s.org])).rowCount).toBe(1);
    const wc = await call('POST', '/api/v1/channels', { user: s.owner, org: s.org, body: { kind: 'web_chat', name: 'Widget', allowed_origins: ['https://shop.example'] } });
    expect([wc.status, wc.body.data.public_key]).toEqual([201, expect.stringMatching(/^[a-f0-9]{32}$/)]);
    for (const body of [{ kind: 'web_chat', name: 'W', allowed_origins: [] }, { kind: 'web_chat', name: 'W', allowed_origins: ['https://x.example/path'] }, { kind: 'email', name: 'E', address: 'bad' }, { kind: 'sms', name: 'x' }])
      expect((await call('POST', '/api/v1/channels', { user: s.owner, org: s.org, body })).status).toBe(422);
  });
});

describe('email webhook: signature, replay, duplicates', () => {
  it('rejects forged/stale/foreign-secret requests with 401 and stores nothing; unknown channel 404', async () => {
    const a = await setup(); const b = await setup(); const p = mail(`m-${uniq()}`);
    for (const r of [
      await call('POST', `/api/v1/webhooks/email/${a.channel}`, { body: p, headers: rip() }),                                             // unsigned
      await hook(a.channel, a.secret, p, { sign: 'wrong-secret' }),
      await hook(a.channel, a.secret, p, { ts: String(Math.floor(Date.now() / 1000) - 3600) }),                                            // replayed old capture
      await hook(a.channel, b.secret, p),                                                                                                  // another org's secret
      await hook(a.channel, a.secret, p, { raw: JSON.stringify(p) + ' ', sign: a.secret, ts: '1' }),
    ]) expect(r.status).toBe(401);
    expect((await hook(crypto.randomUUID(), a.secret, p)).status).toBe(404);
    expect(await counts(a.org)).toMatchObject({ ev: 0, msg: 0 });
    // body is tampered after signing
    const ts = String(Math.floor(Date.now() / 1000)); const raw = JSON.stringify(p);
    expect((await call('POST', `/api/v1/webhooks/email/${a.channel}`, { raw: raw.replace('late', 'LATE'), headers: { ...rip(), 'x-signature-timestamp': ts, 'x-signature': signBody(a.secret, ts, raw) } })).status).toBe(401);
    expect((await counts(a.org)).ev).toBe(0);
  });
  it('validly signed but malformed or org-injecting payloads store nothing', async () => {
    const a = await setup();
    expect((await hook(a.channel, a.secret, null, { raw: '{not json' })).status).toBe(422);
    expect((await hook(a.channel, a.secret, { ...mail('x1'), org_id: crypto.randomUUID() })).status).toBe(422);
    expect((await hook(a.channel, a.secret, { from: { email: 'nope' } })).status).toBe(422);
    expect((await counts(a.org)).ev).toBe(0);
  });
  it('creates one customer/conversation/message; replays and Message-ID case/bracket variants are acknowledged without side effects', async () => {
    const a = await setup(); const id = `Dup-${uniq()}`; const p = mail(id, { message_id: `<${id.toUpperCase()}@Mail.Example>` });
    expect((await hook(a.channel, a.secret, p)).body.data).toEqual({ duplicate: false });
    expect((await hook(a.channel, a.secret, p)).body.data).toEqual({ duplicate: true });
    expect((await hook(a.channel, a.secret, { ...p, message_id: ` ${id.toLowerCase()}@mail.example ` })).body.data).toEqual({ duplicate: true });
    await runJobs();
    expect(await counts(a.org)).toEqual({ ev: 1, msg: 1, conv: 1, cust: 1 });
    expect((await pool.query('select status from webhook_events where org_id=$1', [a.org])).rows[0].status).toBe('processed');
  });
  it('concurrent copies of one message (and concurrent job runners) yield exactly one event, message, conversation', async () => {
    const a = await setup(); const p = mail(`conc-${uniq()}`);
    const rs = await Promise.all(Array.from({ length: 8 }, () => hook(a.channel, a.secret, p)));
    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(200)); expect(rs.filter((r) => r.body.data.duplicate === false)).toHaveLength(1);
    await Promise.all([runJobs(), runJobs(), runJobs()]);
    expect(await counts(a.org)).toEqual({ ev: 1, msg: 1, conv: 1, cust: 1 });
    // process_inbound itself is safe to race (e.g. two events for one mail from a re-processing provider)
    const { rows } = await pool.query("select payload from webhook_events where org_id=$1", [a.org]);
    const rs2 = await Promise.all(Array.from({ length: 6 }, () => pool.query("select * from process_inbound($1,$2,$3)", [a.org, a.channel, rows[0].payload])));
    expect(rs2.filter((r) => r.rows[0].out_dup === false)).toHaveLength(0);
    expect((await counts(a.org)).msg).toBe(1);
  });
  it('two orgs receiving the same Message-ID each get their own message; a fresh customer race makes one customer', async () => {
    const a = await setup(); const b = await setup(); const p = mail(`shared-${uniq()}`, { from: { email: `same-${uniq()}@example.com` } });
    await Promise.all([hook(a.channel, a.secret, p), hook(b.channel, b.secret, p)]); await runJobs();
    expect([(await counts(a.org)).msg, (await counts(b.org)).msg]).toEqual([1, 1]);
    const c = await setup(); const from = { email: `race-${uniq()}@example.com` };
    await Promise.all(Array.from({ length: 5 }, (_, i) => hook(c.channel, c.secret, mail(`race-${uniq()}-${i}`, { from, subject: `s${i}` })))); await runJobs(); await runJobs();
    expect(await counts(c.org)).toMatchObject({ msg: 5, cust: 1 });
  });
  it('threads replies by In-Reply-To / References and starts a new conversation otherwise', async () => {
    const a = await setup(); const from = { email: `th-${uniq()}@example.com` };
    // processed one at a time: a reply that overtakes its parent in the queue starts its own conversation (documented limitation)
    const m1 = mail(`t1-${uniq()}`, { from }); await hook(a.channel, a.secret, m1); await runJobs();
    await hook(a.channel, a.secret, mail(`t2-${uniq()}`, { from, subject: 'Re: Where is my order?', in_reply_to: m1.message_id.toUpperCase() })); await runJobs();
    await hook(a.channel, a.secret, mail(`t3-${uniq()}`, { from, subject: 'Re: again', references: [`<root-${uniq()}@x>`, m1.message_id] })); await runJobs();
    await hook(a.channel, a.secret, mail(`t4-${uniq()}`, { from, subject: 'Different topic' })); await runJobs();
    const r = await counts(a.org); expect([r.conv, r.msg, r.cust]).toEqual([2, 4, 1]);
  });
  it('a paused channel refuses webhooks (404, nothing stored)', async () => {
    const a = await setup(); expect((await call('PATCH', `/api/v1/channels/${a.channel}`, { user: a.owner, org: a.org, body: { status: 'paused' } })).status).toBe(200);
    expect((await hook(a.channel, a.secret, mail(`p-${uniq()}`))).status).toBe(404); expect((await counts(a.org)).ev).toBe(0);
  });
});

describe('conversations API: isolation, permissions, state', () => {
  async function withConv() {
    const s = await setup(); const agent = await mkUser('ag2', true, { aal: 'aal1' }); await addMember(s.org, s.owner, agent, 'agent');
    const viewer = await mkUser('vw', true, { aal: 'aal1' }); await addMember(s.org, s.owner, viewer, 'viewer');
    await hook(s.channel, s.secret, mail(`c-${uniq()}`, { subject: 'Refund Zebra', from: { email: 'zed@example.com', name: 'Zed Z' } })); await runJobs();
    const list = await call('GET', '/api/v1/conversations', { user: agent, org: s.org });
    return { ...s, agent, viewer, conv: list.body.data[0] as { id: string } };
  }
  it('lists with customer, unread, filters and search; viewers read but cannot act; other orgs see nothing', async () => {
    const s = await withConv(); const other = await mkUser('oth'); const orgO = await mkOrg(other);
    const list = await call('GET', '/api/v1/conversations', { user: s.agent, org: s.org });
    expect(list.body.data).toHaveLength(1); expect(list.body.data[0]).toMatchObject({ status: 'open', unread_count: 1, customer: { display_name: 'Zed Z', email: 'zed@example.com' }, last_message_preview: 'Hello, my order is late.' });
    for (const [q, n] of [['q=zebra', 1], ['q=ZED', 1], ['q=nomatch', 0], ['status=resolved', 0], ['assignee=unassigned', 1], ['assignee=me', 0], ['unread=1', 1], ['q=%25%2C()', 1]] as [string, number][])
      expect((await call('GET', `/api/v1/conversations?${q}`, { user: s.agent, org: s.org })).body.data, q).toHaveLength(n);
    expect((await call('GET', `/api/v1/conversations/${s.conv.id}`, { user: s.viewer, org: s.org })).body.data.messages).toHaveLength(1);
    expect((await call('PATCH', `/api/v1/conversations/${s.conv.id}`, { user: s.viewer, org: s.org, body: { status: 'resolved' } })).status).toBe(403);
    expect((await call('POST', `/api/v1/conversations/${s.conv.id}/messages`, { user: s.viewer, org: s.org, body: { body: 'x', client_id: crypto.randomUUID() } })).status).toBe(403);
    // foreign org: header org mismatch, direct id, PostgREST, direct writes
    expect((await call('GET', `/api/v1/conversations/${s.conv.id}`, { user: other, org: orgO })).status).toBe(404);
    expect((await call('GET', '/api/v1/conversations', { user: other, org: orgO })).body.data).toHaveLength(0);
    expect((await call('GET', '/api/v1/conversations', { user: other, org: s.org })).status).toBe(404);
    expect((await call('PATCH', `/api/v1/conversations/${s.conv.id}`, { user: other, org: orgO, body: { status: 'closed' } })).status).toBe(404);
    expect((await call('POST', `/api/v1/conversations/${s.conv.id}/messages`, { user: other, org: orgO, body: { body: 'x', client_id: crypto.randomUUID() } })).status).toBe(404);
    const rest = (t: string, tok = other.token) => fetch(`${SB}/rest/v1/${t}?select=id`, { headers: { apikey: process.env.ANON_KEY!, authorization: `Bearer ${tok}` } }).then((r) => r.json());
    for (const t of ['conversations', 'messages', 'customers', 'customer_identities', 'attachments']) expect(await rest(t), t).toEqual([]);
    for (const t of ['webhook_events', 'chat_sessions', 'jobs']) expect((await fetch(`${SB}/rest/v1/${t}?select=id`, { headers: { apikey: process.env.ANON_KEY!, authorization: `Bearer ${s.agent.token}` } })).status).toBeGreaterThanOrEqual(401);
    const ins = await fetch(`${SB}/rest/v1/messages`, { method: 'POST', headers: { apikey: process.env.ANON_KEY!, authorization: `Bearer ${s.agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ org_id: s.org, conversation_id: s.conv.id, channel_account_id: s.channel, direction: 'outbound', sender_type: 'agent', body: 'forged', status: 'sent' }) });
    expect(ins.status).toBeGreaterThanOrEqual(400);
  });
  it('assign / status / priority / read are validated and audited; assignee must be an agent+ of the same org', async () => {
    const s = await withConv(); const base = `/api/v1/conversations/${s.conv.id}`; const outsider = await mkUser('out', true, { aal: 'aal1' });
    const p1 = await call('PATCH', base, { user: s.agent, org: s.org, body: { assignee_id: s.agent.id, status: 'waiting_customer', priority: 'urgent' } }); expect(p1.status, p1.text).toBe(200);
    expect((await call('GET', base, { user: s.agent, org: s.org })).body.data).toMatchObject({ assignee_id: s.agent.id, status: 'waiting_customer', priority: 'urgent' });
    for (const body of [{ assignee_id: s.viewer.id }, { assignee_id: outsider.id }, { status: 'bogus' }, { priority: 'x' }, {}, { org_id: s.org }]) expect((await call('PATCH', base, { user: s.agent, org: s.org, body })).status, JSON.stringify(body)).toBe(422);
    expect((await call('PATCH', base, { user: s.agent, org: s.org, body: { status: 'resolved' } })).status).toBe(200);
    expect((await pool.query('select resolved_at from conversations where id=$1', [s.conv.id])).rows[0].resolved_at).toBeTruthy();
    expect((await call('PATCH', base, { user: s.agent, org: s.org, body: { assignee_id: null } })).status).toBe(200);
    expect((await pool.query("select metadata->>'fields' f from audit_logs where org_id=$1 and action='conversation.update' order by id", [s.org])).rows.map((r) => r.f)).toEqual(['status,priority,assignee', 'status', 'assignee']);
    await pool.query("update conversations set unread_count=3 where id=$1", [s.conv.id]);
    expect((await call('POST', `${base}/read`, { user: s.agent, org: s.org })).status).toBe(200);
    expect((await pool.query('select unread_count from conversations where id=$1', [s.conv.id])).rows[0].unread_count).toBe(0);
  });
  it('a new inbound message reopens a resolved conversation and bumps unread', async () => {
    const s = await withConv(); await call('PATCH', `/api/v1/conversations/${s.conv.id}`, { user: s.agent, org: s.org, body: { status: 'resolved' } });
    const { rows } = await pool.query('select m.external_id, c.external_thread_id from messages m join conversations c on c.id=m.conversation_id where m.org_id=$1', [s.org]);
    const from = (await pool.query("select value from customer_identities where org_id=$1", [s.org])).rows[0].value;
    await hook(s.channel, s.secret, mail(`re-${uniq()}`, { from: { email: from }, in_reply_to: rows[0].external_id })); await runJobs();
    expect((await pool.query('select status, unread_count, resolved_at from conversations where id=$1', [s.conv.id])).rows[0]).toMatchObject({ status: 'open', unread_count: 2, resolved_at: null });
  });
});

describe('outbound email: send, idempotency, failure, retry', () => {
  it('reply is queued, sent through SMTP with threading headers, and a repeated client_id sends nothing twice', async () => {
    const smtp = await fakeSmtp(); const s = await setup(`smtp://127.0.0.1:${smtp.port}`); const m1 = mail(`o-${uniq()}`, { from: { email: 'buyer@example.com' } });
    await hook(s.channel, s.secret, m1); await runJobs();
    const conv = (await call('GET', '/api/v1/conversations', { user: s.owner, org: s.org })).body.data[0].id as string; const cid = crypto.randomUUID();
    const send = () => call('POST', `/api/v1/conversations/${conv}/messages`, { user: s.owner, org: s.org, body: { body: 'We are on it.\n.dot line', client_id: cid } });
    const r1 = await send(); const r2 = await send();
    expect([r1.status, r1.body.data.status, r2.status, r2.body.data.duplicate, r2.body.data.id]).toEqual([201, 'queued', 200, true, r1.body.data.id]);
    await runJobs(); await runJobs();
    expect((await pool.query('select status from messages where id=$1', [r1.body.data.id])).rows[0].status).toBe('sent');
    expect(smtp.got).toHaveLength(1);
    const d = smtp.got[0]; expect(d).toContain(`In-Reply-To: <${m1.message_id.slice(1, -1)}>`); expect(d).toContain(`Message-ID: <${cid}@csai.local>`); expect(d).toMatch(/Subject: =\?UTF-8\?B\?/);
    const c = (await call('GET', `/api/v1/conversations/${conv}`, { user: s.owner, org: s.org })).body.data; expect(c).toMatchObject({ status: 'waiting_customer', unread_count: 0 });
    // internal notes are never mailed
    expect((await call('POST', `/api/v1/conversations/${conv}/messages`, { user: s.owner, org: s.org, body: { body: 'note to self', client_id: crypto.randomUUID(), internal: true } })).body.data.status).toBe('sent');
    await runJobs(); expect(smtp.got).toHaveLength(1);
    smtp.srv.close();
  });
  it('SMTP failures retry with backoff, end as failed after max attempts (not silently), and a manual retry delivers once the transport recovers', async () => {
    const port = await freePort(); const s = await setup(`smtp://127.0.0.1:${port}`);
    await hook(s.channel, s.secret, mail(`f-${uniq()}`, { from: { email: 'late@example.com' } })); await runJobs();
    const conv = (await call('GET', '/api/v1/conversations', { user: s.owner, org: s.org })).body.data[0].id as string;
    const mid = (await call('POST', `/api/v1/conversations/${conv}/messages`, { user: s.owner, org: s.org, body: { body: 'hi', client_id: crypto.randomUUID() } })).body.data.id as string;
    const st = async () => (await pool.query('select status, error_code from messages where id=$1', [mid])).rows[0];
    await runJobs(); expect((await st()).status).toBe('queued');                                   // attempt 1 failed, will retry
    for (let i = 0; i < 4; i++) { await fastForward(s.org); await runJobs(); }
    expect(await st()).toEqual({ status: 'failed', error_code: 'connect_refused' });
    expect((await pool.query("select status, attempts from jobs where org_id=$1 and type='send_outbound'", [s.org])).rows[0]).toEqual({ status: 'dead', attempts: 5 });
    expect((await call('POST', `/api/v1/messages/${mid}/retry`, { user: s.owner, org: s.org })).status).toBe(200);
    expect((await call('POST', `/api/v1/messages/${mid}/retry`, { user: s.owner, org: s.org })).status).toBe(409);   // already queued again
    const smtp = await fakeSmtp(port); await runJobs();
    expect((await st()).status).toBe('sent'); expect(smtp.got).toHaveLength(1); smtp.srv.close();
    const stranger = await mkUser('str'); const o2 = await mkOrg(stranger);
    expect((await call('POST', `/api/v1/messages/${mid}/retry`, { user: stranger, org: o2 })).status).toBe(404);
  });
  it('without any transport the message fails with a clear code instead of retrying forever', async () => {
    const s = await setup();
    await hook(s.channel, s.secret, mail(`nt-${uniq()}`, { from: { email: 'x@example.com' } })); await runJobs();
    const conv = (await call('GET', '/api/v1/conversations', { user: s.owner, org: s.org })).body.data[0].id as string;
    const mid = (await call('POST', `/api/v1/conversations/${conv}/messages`, { user: s.owner, org: s.org, body: { body: 'hi', client_id: crypto.randomUUID() } })).body.data.id;
    await runJobs(); expect((await pool.query('select status,error_code from messages where id=$1', [mid])).rows[0]).toEqual({ status: 'failed', error_code: 'no_transport' });
  });
});

describe('web chat', () => {
  const ORIGIN = 'https://shop.example';
  const chat = (method: string, path: string, o: { token?: string; origin?: string | null; body?: unknown } = {}) =>
    fetch(`${BASE}/api/v1/chat${path}`, { method, headers: { ...rip(), 'content-type': 'application/json', ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
  async function widget() {
    const owner = await mkUser('wo'); const org = await mkOrg(owner);
    const ch = await call('POST', '/api/v1/channels', { user: owner, org, body: { kind: 'web_chat', name: 'Widget', allowed_origins: [ORIGIN] } });
    return { owner, org, key: ch.body.data.public_key as string, channel: ch.body.data.id as string };
  }
  const start = (key: string, extra: object = {}, origin: string | null = ORIGIN) => chat('POST', '/sessions', { origin, body: { public_key: key, visitor_id: `vis-${uniq()}${uniq()}`, ...extra } });
  it('sessions require the channel key and an allowed Origin; the token is stored only as a hash', async () => {
    const w = await widget();
    expect((await start(w.key, {}, 'https://evil.example')).status).toBe(403); expect((await start(w.key, {}, null)).status).toBe(403); expect((await start('0'.repeat(32))).status).toBe(403);
    expect((await chat('POST', '/sessions', { body: { public_key: w.key, visitor_id: 'short' } })).status).toBe(422);
    const s = await start(w.key, { name: 'Visitor V' }); expect(s.status).toBe(201); expect(s.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const tok = s.body.data.token as string; expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await pool.query("select encode(token_hash,'hex') h from chat_sessions where org_id=$1", [w.org]); expect(rows.rows[0].h).not.toContain(tok);
    expect((await fetch(`${BASE}/api/v1/chat/sessions`, { method: 'OPTIONS' })).status).toBe(204);
  });
  it('visitor messages dedupe by client_id, land in the agent inbox, and replies/notes are exposed correctly', async () => {
    const w = await widget(); const s = await start(w.key); const tok = s.body.data.token as string; const cid = `msg-${uniq()}${uniq()}`;
    const m1 = await chat('POST', '/messages', { token: tok, body: { body: 'Hi, need help', client_id: cid } }); const m2 = await chat('POST', '/messages', { token: tok, body: { body: 'Hi, need help', client_id: cid } });
    expect([m1.status, m2.status, m2.body.data.duplicate, m2.body.data.id]).toEqual([201, 200, true, m1.body.data.id]);
    const conv = (await call('GET', '/api/v1/conversations', { user: w.owner, org: w.org })).body.data; expect(conv).toHaveLength(1); expect(conv[0]).toMatchObject({ unread_count: 1, last_message_preview: 'Hi, need help' });
    const id = conv[0].id as string;
    await call('POST', `/api/v1/conversations/${id}/messages`, { user: w.owner, org: w.org, body: { body: 'Internal: VIP', client_id: crypto.randomUUID(), internal: true } });
    await call('POST', `/api/v1/conversations/${id}/messages`, { user: w.owner, org: w.org, body: { body: 'Hello! How can I help?', client_id: crypto.randomUUID() } });
    const feed = await chat('GET', '/messages', { token: tok }); expect(feed.body.data.map((m: { body: string }) => m.body)).toEqual(['Hi, need help', 'Hello! How can I help?']);
    expect(feed.body.data.every((m: Record<string, unknown>) => Object.keys(m).sort().join() === 'body,created_at,direction,id')).toBe(true);
    const later = await chat('GET', `/messages?after=${encodeURIComponent(feed.body.data[1].created_at)}`, { token: tok }); expect(later.body.data.map((m: { id: string }) => m.id)).toEqual([feed.body.data[1].id]);   // cursor is inclusive (>=): only the boundary message repeats; clients dedupe by id
  });
  it('a token is scoped to its own conversation and origin; revoked, expired, idle, garbage tokens get 401', async () => {
    const w = await widget(); const a = await start(w.key); const b = await start(w.key);
    await chat('POST', '/messages', { token: a.body.data.token, body: { body: 'A-secret', client_id: `a-${uniq()}${uniq()}` } });
    expect((await chat('GET', '/messages', { token: b.body.data.token })).body.data).toEqual([]);                              // B cannot see A
    expect((await chat('GET', '/messages', { token: a.body.data.token, origin: 'https://evil.example' })).status).toBe(401);   // stolen token on another origin
    expect((await chat('GET', '/messages', { token: 'x'.repeat(43) })).status).toBe(401); expect((await chat('GET', '/messages')).status).toBe(401);
    for (const [sql, label] of [["revoked_at = now()", 'revoked'], ["expires_at = now() - interval '1 second'", 'expired'], ["last_seen_at = now() - interval '31 minutes'", 'idle']] as const) {
      const x = await start(w.key); await pool.query(`update chat_sessions set ${sql} where org_id=$1 and conversation_id=$2`, [w.org, x.body.data.conversation_id]);
      expect((await chat('POST', '/messages', { token: x.body.data.token, body: { body: 'hi', client_id: `z-${uniq()}${uniq()}` } })).status, label).toBe(401);
    }
    expect((await chat('POST', '/messages', { token: a.body.data.token, body: { body: 'x'.repeat(4001), client_id: `l-${uniq()}${uniq()}` } })).status).toBe(422);
  });
  it('a paused widget accepts no new sessions; other orgs cannot see the chat conversation', async () => {
    const w = await widget(); const s = await start(w.key); await chat('POST', '/messages', { token: s.body.data.token, body: { body: 'hello', client_id: `p-${uniq()}${uniq()}` } });
    await call('PATCH', `/api/v1/channels/${w.channel}`, { user: w.owner, org: w.org, body: { status: 'paused' } });
    expect((await start(w.key)).status).toBe(403);
    const other = await mkUser('ow2'); const o2 = await mkOrg(other);
    expect((await call('GET', '/api/v1/conversations', { user: other, org: o2 })).body.data).toEqual([]);
  });
});

describe('logs', () => {
  it('server log contains no webhook secrets, message bodies or customer addresses', async () => {
    const s = await setup(); const p = mail(`lg-${uniq()}`, { text: 'SENTINEL-BODY-91827', from: { email: 'sentinel-person@example.com' } });
    await hook(s.channel, s.secret, p); await runJobs();
    const log = process.env.NEXT_LOG ? readFileSync(process.env.NEXT_LOG, 'utf8') : '';
    for (const x of [s.secret, 'SENTINEL-BODY-91827', 'sentinel-person@example.com']) expect(log).not.toContain(x);
    void (null as unknown as TUser);
  });
});
