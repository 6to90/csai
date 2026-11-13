import { describe, expect, it } from 'vitest';
import { pool, realLogin, TEST_PASSWORD, uniq } from '../api/helpers';

// REAL local Supabase (GoTrue) + a Next server wired to a REAL mail transport (Mailpit). Everything an invitee receives (invitation link, verification
// code) is read from the mailbox, exactly as a person would. Run via scripts/test-supabase.sh (API_BASE_MAIL points at that second server).
const BASE = process.env.API_BASE_MAIL!, MAIL = process.env.MAIL_URL!;
const CRON = { authorization: 'Bearer test-cron-secret-value' };
const ip = () => ({ 'x-forwarded-for': `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const api = async (method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; token?: string } = {}) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...ip(), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text(); let body: any = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, text };
};
type Mail = { ID: string; Subject: string; Text: string };
async function mailsTo(addr: string): Promise<Mail[]> {
  for (let i = 0; i < 30; i++) {                                                              // delivery is asynchronous: poll the mailbox
    const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${addr}`)}`)).json() as { messages?: { ID: string }[] };
    const msgs = await Promise.all((list.messages ?? []).map(async (m) => (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json() as Promise<Mail>));
    if (msgs.length) return msgs; await new Promise((r) => setTimeout(r, 300));
  }
  return [];
}
const waitFor = async (addr: string, pred: (m: Mail) => boolean) => { for (let i = 0; i < 30; i++) { const m = (await mailsTo(addr)).find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 300)); } throw new Error(`no matching mail for ${addr}`); };
const tokenFrom = (m: Mail) => decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m.Text)![1]);
const codeFrom = (m: Mail) => /\b(\d{8})\b/.exec(m.Text)![1];
const preview = (token: string) => api('POST', '/api/v1/invitations/preview', { body: { token } });
const redeem = (body: Record<string, unknown>) => api('POST', '/api/v1/invitations/redeem', { body });
const acceptFirst = async (email: string) => {                                                  // operator provisions a customer: the invitation goes to the mailbox only
  const slug = `mb-${uniq()}`; const r = await api('POST', '/api/internal/customers', { headers: CRON, body: { email, org_name: 'Mailbox Co', slug } });
  expect(r.status).toBe(201); expect(r.body.data.mail_sent).toBe(true); expect(r.body.data.accept_url).toBeUndefined();   // the link is NOT in the API response
  return tokenFrom(await waitFor(email, (m) => /token=/.test(m.Text)));
};

describe('invitation sign-up proves mailbox ownership (real GoTrue + real mailbox)', () => {
  it('new user: link from the mailbox -> 202 -> code from the mailbox -> 201 -> real login -> accept; wrong/guessed codes create nothing', async () => {
    const email = `mb-${uniq()}@example.com`; const token = await acceptFirst(email);
    expect((await preview(token)).body.data).toMatchObject({ email, has_account: false });

    const step1 = await redeem({ token, password: TEST_PASSWORD });
    expect(step1.status).toBe(202); expect(step1.text).not.toMatch(/\b\d{8}\b/);                 // the code is never in the response
    const mail = await waitFor(email, (m) => /확인 코드/.test(m.Subject)); const code = codeFrom(mail);

    // a holder of the link who cannot read the mailbox: guesses fail and NOTHING is created in GoTrue
    for (const bad of ['00000000', '12345678', code === '99999999' ? '11111111' : '99999999']) expect((await redeem({ token, password: 'Attacker-Password-1!', code: bad })).status).toBe(422);
    expect((await pool.query('select 1 from auth.users where lower(email)=$1', [email])).rowCount).toBe(0);
    expect((await preview(token)).body.data.has_account).toBe(false);

    // the real invitee reads the code from the mailbox: the account is created CONFIRMED, with the invitee's password (not the attacker's)
    expect((await redeem({ token, password: TEST_PASSWORD, code })).status).toBe(201);
    const u = (await pool.query('select email_confirmed_at from auth.users where lower(email)=$1', [email])).rows[0]; expect(u.email_confirmed_at).not.toBeNull();
    await expect(realLogin(email, 'Attacker-Password-1!')).rejects.toMatchObject({ status: 400 });
    const s = await realLogin(email, TEST_PASSWORD);
    const acc = await api('POST', '/api/v1/invitations/accept', { token: s.access_token, body: { token } }); expect(acc.status).toBe(200);
    // reuse: the link and the code are dead after acceptance
    expect((await api('POST', '/api/v1/invitations/accept', { token: s.access_token, body: { token } })).status).toBeGreaterThanOrEqual(400);
    expect([(await preview(token)).status, (await redeem({ token, password: TEST_PASSWORD, code })).status]).toEqual([404, 404]);
  });

  it('a verification code mailed for one invitation does not work for another invitation (token/e-mail bound)', async () => {
    const e1 = `mb-${uniq()}@example.com`, e2 = `mb-${uniq()}@example.com`; const t1 = await acceptFirst(e1), t2 = await acceptFirst(e2);
    expect((await redeem({ token: t1, password: TEST_PASSWORD })).status).toBe(202);
    const code1 = codeFrom(await waitFor(e1, (m) => /확인 코드/.test(m.Subject)));
    expect((await redeem({ token: t2, password: TEST_PASSWORD, code: code1 })).status).toBe(422);   // e2's token + e1's code
    expect((await pool.query('select 1 from auth.users where lower(email) in ($1,$2)', [e1, e2])).rowCount).toBe(0);
  });

  it('existing account: no code mail is sent, the password is untouched (409), and a different signed-in e-mail cannot accept', async () => {
    const email = `mb-${uniq()}@example.com`; const token = await acceptFirst(email);
    const other = `other-${uniq()}@example.com`;
    for (const e of [email, other]) { const c = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: process.env.SERVICE_KEY!, authorization: `Bearer ${process.env.SERVICE_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: TEST_PASSWORD, email_confirm: true }) }); expect(c.status).toBe(200); }
    const before = (await mailsTo(email)).length;
    expect((await redeem({ token, password: 'Another-Password-999!' })).status).toBe(409);
    await new Promise((r) => setTimeout(r, 800)); expect((await mailsTo(email)).length).toBe(before);   // nothing new was mailed
    const so = await realLogin(other, TEST_PASSWORD);
    expect((await api('POST', '/api/v1/invitations/accept', { token: so.access_token, body: { token } })).status).toBe(403);   // email mismatch, token NOT consumed
    const si = await realLogin(email, TEST_PASSWORD);
    expect((await api('POST', '/api/v1/invitations/accept', { token: si.access_token, body: { token } })).status).toBe(200);
  });
});
