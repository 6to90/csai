import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BASE, call, mkOrg, mkUser, pool, uniq } from '../api/helpers';
import { signBody } from '@/server/domain/email';

// REAL local Supabase + Next server. Production email path: raw RFC 5322 inbound, threading, send outcomes. Run via scripts/test-supabase.sh.
const CRON = { authorization: 'Bearer test-cron-secret-value' };
const rip = () => ({ 'x-forwarded-for': `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const runJobs = async () => { for (let i = 0; i < 6; i++) { const r = await call('POST', '/api/internal/jobs/run', { headers: CRON }); if (!r.body?.data?.claimed) return; } };
const fastForward = (org: string) => pool.query("update jobs set run_at = now() where org_id=$1 and status in ('failed','queued')", [org]);

function smtp(o: { rcpt?: string; dataReply?: string; drop?: boolean } = {}, port = 0) {
  const data: string[] = []; const cfg = { ...o };
  const srv: Server = createServer((s) => {
    let inData = false, buf = ''; s.on('error', () => undefined); s.write('220 t\r\n');
    s.on('data', (d) => { buf += d.toString(); for (;;) {
      if (inData) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) return; data.push(buf.slice(0, e)); buf = buf.slice(e + 5); inData = false; if (cfg.drop) { s.destroy(); return; } s.write(`${cfg.dataReply ?? '250 2.0.0 Ok: queued as QX9'}\r\n`); continue; }
      const i = buf.indexOf('\r\n'); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (line.startsWith('EHLO')) s.write('250 t\r\n'); else if (line.startsWith('RCPT')) s.write(`${cfg.rcpt ?? '250'} rcpt\r\n`); else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') s.end('221 bye\r\n'); else s.write('250 ok\r\n');
    } });
  });
  return new Promise<{ srv: Server; port: number; data: string[]; cfg: typeof cfg }>((r) => srv.listen(port, '127.0.0.1', () => r({ srv, port: (srv.address() as { port: number }).port, data, cfg })));
}
async function setup(smtpUrl?: string) {
  const owner = await mkUser('ep'); const org = await mkOrg(owner);
  const ch = await call('POST', '/api/v1/channels', { user: owner, org, body: { kind: 'email', name: 'Support', address: `support-${uniq()}@acme.test`, from_name: 'Acme 지원', ...(smtpUrl ? { smtp_url: smtpUrl } : {}) } });
  expect(ch.status).toBe(201);
  return { owner, org, channel: ch.body.data.id as string, secret: ch.body.data.webhook_secret as string };
}
const rfc822 = (channel: string, secret: string, raw: string | Buffer, o: { sign?: string; ts?: string; type?: string } = {}) => {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, '\r\n'), 'utf8'); const ts = o.ts ?? String(Math.floor(Date.now() / 1000));
  return fetch(`${BASE}/api/v1/webhooks/email/${channel}`, { method: 'POST', headers: { ...rip(), 'content-type': o.type ?? 'message/rfc822', 'x-signature-timestamp': ts, 'x-signature': signBody(o.sign ?? secret, ts, body) }, body: new Uint8Array(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
};
const eml = (id: string, o: { from?: string; subject?: string; refs?: string[]; reply?: string; body?: string; ct?: string; extra?: string } = {}) =>
  `From: ${o.from ?? 'Kim <kim@example.com>'}\nTo: support@acme.test\nSubject: ${o.subject ?? 'Order question'}\nMessage-ID: <${id}@mail.example>\n${o.reply ? `In-Reply-To: <${o.reply}@mail.example>\n` : ''}${o.refs ? `References: ${o.refs.map((r) => `<${r}@mail.example>`).join(' ')}\n` : ''}${o.extra ?? ''}${o.ct ?? 'Content-Type: text/plain; charset=utf-8'}\n\n${o.body ?? 'Hello there'}\n`;
const convs = async (org: string) => (await pool.query("select c.id, c.external_thread_id, c.subject, (select count(*)::int from messages m where m.conversation_id=c.id) n from conversations c where org_id=$1 order by created_at", [org])).rows;

describe('raw RFC 5322 inbound', () => {
  it('verifies the signature over the raw bytes; parses headers/multipart/attachments; HTML is stored as text only', async () => {
    const s = await setup(); const id = `raw-${uniq()}`;
    const mime = `From: =?UTF-8?B?6rmA6rOg6rCd?= <Kim.Customer@Example.com>\nTo: Support <support@acme.test>\nSubject: =?UTF-8?B?7KO866y4IOusuOydmA==?=\nMessage-ID: <${id}@Mail.Example>\nContent-Type: multipart/mixed; boundary=OUT\n\n--OUT\nContent-Type: text/html; charset=utf-8\n\n<p onclick="x()">Hi</p><script>alert(1)</script><img src=x onerror=alert(2)>안녕하세요 &amp; 감사합니다\n--OUT\nContent-Type: application/x-msdownload; name="../../evil.exe"\nContent-Disposition: attachment; filename="../../evil.exe"\nContent-Transfer-Encoding: base64\n\n${Buffer.from('MZfake').toString('base64')}\n--OUT--\n`;
    expect((await rfc822(s.channel, s.secret, mime, { sign: 'wrong' })).status).toBe(401);
    expect((await rfc822(s.channel, s.secret, mime + ' tampered', { ts: String(Math.floor(Date.now() / 1000) - 1000) })).status).toBe(401);
    expect(((await pool.query('select count(*)::int n from webhook_events where org_id=$1', [s.org])).rows[0]).n).toBe(0);
    expect((await rfc822(s.channel, s.secret, mime)).body.data).toEqual({ duplicate: false });
    expect((await rfc822(s.channel, s.secret, mime)).body.data).toEqual({ duplicate: true });
    await runJobs();
    const list = (await call('GET', '/api/v1/conversations', { user: s.owner, org: s.org })).body.data; expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ subject: '주문 문의', customer: { display_name: '김고객', email: 'kim.customer@example.com' } });
    const d = (await call('GET', `/api/v1/conversations/${list[0].id}`, { user: s.owner, org: s.org })).body.data;
    expect(d.messages).toHaveLength(1);
    expect(d.messages[0].body).toBe('Hi\n안녕하세요 & 감사합니다'); expect(d.messages[0].body).not.toMatch(/<|alert|onerror|onclick/);
    expect(d.messages[0].attachments).toEqual([expect.objectContaining({ mime: 'application/x-msdownload', size: 6, filename: expect.not.stringMatching(/[/\\]/) })]);
    expect((await pool.query("select scan_status, storage_path from attachments where org_id=$1", [s.org])).rows[0]).toEqual({ scan_status: 'pending', storage_path: null });   // bytes are never stored
    expect((await pool.query("select 1 from audit_logs where org_id=$1 and action='email.receive'", [s.org])).rowCount).toBe(1);
  });
  it('unparseable messages and header-injection attempts store nothing dangerous', async () => {
    const s = await setup();
    expect((await rfc822(s.channel, s.secret, 'Subject: no sender\n\nbody')).status).toBe(422);
    expect((await pool.query('select count(*)::int n from webhook_events where org_id=$1', [s.org])).rows[0].n).toBe(0);
    const evil = Buffer.from('A\r\nBcc: evil@x.com\0B').toString('base64');
    await rfc822(s.channel, s.secret, eml(`inj-${uniq()}`, { subject: `=?UTF-8?B?${evil}?=`, from: `"x =?UTF-8?B?${evil}?=" <inj@example.com>` })); await runJobs();
    const c = await convs(s.org); expect(c).toHaveLength(1); expect(c[0].subject).not.toMatch(/[\r\n\0]/);
  });
  it('concurrent copies of one raw message produce one message', async () => {
    const s = await setup(); const m = eml(`cc-${uniq()}`);
    const rs = await Promise.all(Array.from({ length: 6 }, () => rfc822(s.channel, s.secret, m)));
    expect(rs.filter((r) => r.body.data.duplicate === false)).toHaveLength(1); await Promise.all([runJobs(), runJobs()]);
    expect((await convs(s.org)).map((c) => c.n)).toEqual([1]);
  });
  it('a different org\'s secret cannot post to this channel; JSON bodies still work', async () => {
    const a = await setup(); const b = await setup();
    expect((await rfc822(a.channel, b.secret, eml(`x-${uniq()}`))).status).toBe(401);
    expect((await rfc822(a.channel, a.secret, JSON.stringify({ message_id: `j-${uniq()}`, from: { email: 'j@example.com' }, text: 'json ok' }), { type: 'application/json' })).status).toBe(200);
  });
});

describe('threading', () => {
  it('replies that arrive BEFORE their parents are joined once the parents show up (any order => one conversation)', async () => {
    const s = await setup(); const root = `root-${uniq()}`, mid = `mid-${uniq()}`, leaf = `leaf-${uniq()}`;
    await rfc822(s.channel, s.secret, eml(leaf, { subject: 'Re: Re: Order', refs: [root, mid], reply: mid })); await runJobs();
    expect(await convs(s.org)).toHaveLength(1);                                       // orphan: safe, own conversation (thread key = root)
    await rfc822(s.channel, s.secret, eml(mid, { subject: 'Re: Order', refs: [root], reply: root })); await runJobs();
    await rfc822(s.channel, s.secret, eml(root, { subject: 'Order' })); await runJobs();
    const c = await convs(s.org); expect(c).toHaveLength(1); expect(c[0].n).toBe(3);
  });
  it('an orphan whose only link is In-Reply-To is adopted when the parent arrives; unrelated mail gets its own conversation; existing messages are untouched', async () => {
    const s = await setup(); const p = `p-${uniq()}`;
    await rfc822(s.channel, s.secret, eml(`c-${uniq()}`, { reply: p, subject: 'Re: X' })); await runJobs();
    await rfc822(s.channel, s.secret, eml(`u-${uniq()}`, { subject: 'Unrelated' })); await runJobs();
    const before = (await pool.query('select id, body, conversation_id from messages where org_id=$1 order by created_at', [s.org])).rows;
    await rfc822(s.channel, s.secret, eml(p, { subject: 'X' })); await runJobs();
    const c = await convs(s.org); expect(c.map((x) => x.n).sort()).toEqual([1, 2]);
    const after = (await pool.query('select id, body, conversation_id from messages where org_id=$1 and id = any($2)', [s.org, before.map((b) => b.id)])).rows;
    expect(after.sort((x, y) => x.id.localeCompare(y.id))).toEqual(before.sort((x, y) => x.id.localeCompare(y.id)));   // no message was moved or rewritten
  });
  it('another customer quoting your Message-ID cannot inject into your conversation (and does not break processing)', async () => {
    const s = await setup(); const a = `a-${uniq()}`;
    await rfc822(s.channel, s.secret, eml(a, { from: 'Alice <alice@example.com>', subject: 'Alice order' })); await runJobs();
    await rfc822(s.channel, s.secret, eml(`m-${uniq()}`, { from: 'Mallory <mallory@example.com>', subject: 'Re: Alice order', reply: a, refs: [a] })); await runJobs();
    const c = await convs(s.org); expect(c).toHaveLength(2); expect(c.map((x) => x.n)).toEqual([1, 1]);
    expect((await pool.query("select status from webhook_events where org_id=$1", [s.org])).rows.map((r) => r.status)).toEqual(['processed', 'processed']);
    const alice = (await pool.query("select count(*)::int n from messages m join customer_identities i on i.customer_id=(select customer_id from conversations where id=m.conversation_id) where m.org_id=$1 and i.value='alice@example.com'", [s.org])).rows[0].n; expect(alice).toBe(1);
  });
  it('threading never crosses organisations', async () => {
    const a = await setup(); const b = await setup(); const id = `x-${uniq()}`;
    await rfc822(a.channel, a.secret, eml(id)); await rfc822(b.channel, b.secret, eml(`y-${uniq()}`, { reply: id, refs: [id] })); await runJobs();
    expect([(await convs(a.org)).length, (await convs(b.org)).length]).toEqual([1, 1]);
  });
});

describe('outbound results', () => {
  const reply = async (s: Awaited<ReturnType<typeof setup>>, text = 'Thanks, we are on it.') => {
    await rfc822(s.channel, s.secret, eml(`in-${uniq()}`, { from: 'Buyer <buyer@example.com>' })); await runJobs();
    const conv = (await call('GET', '/api/v1/conversations', { user: s.owner, org: s.org })).body.data[0].id as string;
    const r = await call('POST', `/api/v1/conversations/${conv}/messages`, { user: s.owner, org: s.org, body: { body: text, client_id: crypto.randomUUID() } });
    return r.body.data.id as string;
  };
  const row = async (id: string) => (await pool.query('select status, error_code, delivery_ref from messages where id=$1', [id])).rows[0];
  const jobOf = async (org: string) => (await pool.query("select status, attempts from jobs where org_id=$1 and type='send_outbound'", [org])).rows[0];

  it('success records the server reference, the From display name and an audit row', async () => {
    const m = await smtp(); const s = await setup(`smtp://127.0.0.1:${m.port}`); const id = await reply(s); await runJobs();
    expect(await row(id)).toEqual({ status: 'sent', error_code: null, delivery_ref: '2.0.0 Ok: queued as QX9' });
    expect(m.data[0]).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <support-/m); expect(m.data[0]).toMatch(/^Date: /m);
    expect((await pool.query("select metadata from audit_logs where org_id=$1 and action='email.send'", [s.org])).rows.map((r) => r.metadata)).toEqual([{ status: 'sent', code: 'ok' }]);
    m.srv.close();
  });
  it('a permanent rejection (550) fails at once, is not retried, and the manual retry stays available', async () => {
    const m = await smtp({ rcpt: '550' }); const s = await setup(`smtp://127.0.0.1:${m.port}`); const id = await reply(s); await runJobs();
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'smtp_550' }); expect(await jobOf(s.org)).toEqual({ status: 'dead', attempts: 1 });
    m.cfg.rcpt = '250'; expect((await call('POST', `/api/v1/messages/${id}/retry`, { user: s.owner, org: s.org })).status).toBe(200); await runJobs();
    expect((await row(id)).status).toBe('sent'); m.srv.close();
  });
  it('a transient error (451) is retried with backoff up to the limit, then fails with the SMTP code', async () => {
    const m = await smtp({ rcpt: '451' }); const s = await setup(`smtp://127.0.0.1:${m.port}`); const id = await reply(s); await runJobs();
    expect(await row(id)).toMatchObject({ status: 'queued' });
    for (let i = 0; i < 4; i++) { await fastForward(s.org); await runJobs(); }
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'smtp_451' }); expect(await jobOf(s.org)).toEqual({ status: 'dead', attempts: 5 }); m.srv.close();
  });
  it('an UNCERTAIN result (connection lost after the body) is never auto-retried; a human retry reuses the same Message-ID', async () => {
    const m = await smtp({ drop: true }); const s = await setup(`smtp://127.0.0.1:${m.port}`); const id = await reply(s); await runJobs();
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'uncertain_delivery' }); expect(await jobOf(s.org)).toEqual({ status: 'dead', attempts: 1 });
    await fastForward(s.org); await runJobs(); expect(m.data).toHaveLength(1);                     // no silent second send
    m.cfg.drop = false; await call('POST', `/api/v1/messages/${id}/retry`, { user: s.owner, org: s.org }); await runJobs();
    expect(m.data).toHaveLength(2); expect(m.data[1].match(/^Message-ID: .*$/m)?.[0]).toBe(m.data[0].match(/^Message-ID: .*$/m)?.[0]); expect((await row(id)).status).toBe('sent'); m.srv.close();
  });
  it('a lease-expired duplicate job cannot send an already-sent message twice', async () => {
    const m = await smtp(); const s = await setup(`smtp://127.0.0.1:${m.port}`); const id = await reply(s); await runJobs();
    await pool.query("update jobs set status='queued', attempts=0, run_at=now() where org_id=$1 and type='send_outbound'", [s.org]); await runJobs();
    expect(m.data).toHaveLength(1); m.srv.close();
  });
  it('audit rows and server logs carry no addresses, bodies or secrets', async () => {
    const m = await smtp(); const s = await setup(`smtp://u:topsecretpw@127.0.0.1:${m.port}`); const id = await reply(s, 'PRIVATE-BODY-5567'); await runJobs();
    expect((await row(id)).status).toBe('failed');                                                  // creds on plain smtp:// are refused, and say why
    expect((await row(id)).error_code).toBe('auth_requires_tls');
    const meta = JSON.stringify((await pool.query("select metadata from audit_logs where org_id=$1", [s.org])).rows);
    for (const x of ['buyer@example.com', 'PRIVATE-BODY-5567', 'topsecretpw', s.secret]) expect(meta).not.toContain(x);
    const log = process.env.NEXT_LOG ? readFileSync(process.env.NEXT_LOG, 'utf8') : '';
    for (const x of ['buyer@example.com', 'PRIVATE-BODY-5567', 'topsecretpw', s.secret]) expect(log).not.toContain(x);
    m.srv.close();
  });
});
