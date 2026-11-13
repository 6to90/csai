import { describe, expect, it } from 'vitest';
import { call, mkOrg, mkUser, sql, uniq } from './helpers';

// Runs against a PRODUCTION build served by `next start` (scripts/test-api.sh). The harness deliberately sets SMTP_ALLOW_PRIVATE_HOSTS=1 on the server
// (without building with CSAI_TEST_BUILD=1) to prove that a production build cannot be switched into allowing internal SMTP targets.
describe('SSRF guard on a production build (real HTTP)', () => {
  const email = (smtp_url: string) => ({ kind: 'email', name: `ch-${uniq()}`, address: `s-${uniq()}@acme.test`, smtp_url });

  it('the private-host exception variable is ignored: internal SMTP targets are refused even though the server runs with SMTP_ALLOW_PRIVATE_HOSTS=1', async () => {
    expect(process.env.SMTP_ALLOW_PRIVATE_HOSTS).toBe('1');                      // the harness really did set it
    const owner = await mkUser('smtp-owner'); const org = await mkOrg(owner);
    const before = (await sql<{ n: string }>('select count(*)::text n from channel_accounts where org_id = $1', [org]))[0].n;
    for (const u of ['smtps://127.0.0.1:465', 'smtp://localhost:25', 'smtps://u:p@10.0.0.5:465', 'smtp://169.254.169.254:25', 'smtps://[::1]:465', 'smtps://127.0.0.1:4465']) {
      const r = await call('POST', '/api/v1/channels', { user: owner, org, body: email(u) });
      expect([u, r.status, r.body.error?.code]).toEqual([u, 422, 'validation_failed']);
    }
    const after = (await sql<{ n: string }>('select count(*)::text n from channel_accounts where org_id = $1', [org]))[0].n;
    expect(after).toBe(before);                                                  // nothing was created
  });
  it('disallowed ports/schemes are refused over HTTP as well', async () => {
    const owner = await mkUser('smtp-owner2'); const org = await mkOrg(owner);
    for (const u of ['smtps://smtp.example.com:6379', 'smtps://smtp.example.com:22', 'http://169.254.169.254/latest/meta-data', 'smtp://user:pw@smtp.example.com:25']) {
      const r = await call('POST', '/api/v1/channels', { user: owner, org, body: email(u) }); expect([u, r.status]).toEqual([u, 422]);
    }
  });
  it('a normal email channel without smtp_url is unaffected', async () => {
    const owner = await mkUser('smtp-owner3'); const org = await mkOrg(owner);
    const r = await call('POST', '/api/v1/channels', { user: owner, org, body: { kind: 'email', name: 'Support', address: `s-${uniq()}@acme.test` } });
    expect(r.status).toBe(201);
  });
});
