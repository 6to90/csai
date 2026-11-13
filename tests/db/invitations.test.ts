import { beforeAll, describe, expect, it } from 'vitest';
import { mkOrg, mkUser, rejects, sup, user } from './helpers';

type U = { id: string; email: string };
let owner: U, org: string;
beforeAll(async () => { owner = await mkUser('owner'); org = await mkOrg(owner.id); });
const invite = async (email: string, role = 'agent') =>
  (await user<{ inv_id: string; inv_token: string }>(owner.id, 'select * from create_invitation($1,$2,$3)', [org, email, role]))[0];
const members = async () => (await sup<{ n: string }>('select count(*) n from memberships where org_id=$1', [org]))[0].n;

describe('invitation tokens', () => {
  it('are single-use: second accept (same or other user) fails', async () => {
    const u = await mkUser('u1'); const other = await mkUser('o1');
    const inv = await invite(u.email);
    const [r] = await user<{ out_role: string }>(u.id, 'select * from accept_invitation($1)', [inv.inv_token]);
    expect(r.out_role).toBe('agent');
    await rejects(user(u.id, 'select * from accept_invitation($1)', [inv.inv_token]), /invitation_invalid/);
    await rejects(user(other.id, 'select * from accept_invitation($1)', [inv.inv_token]), /invitation_invalid/);
  });
  it('concurrent accepts: exactly one succeeds, one membership', async () => {
    const u = await mkUser('u2'); const inv = await invite(u.email);
    const before = await members();
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => user(u.id, 'select * from accept_invitation($1)', [inv.inv_token])));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(Number(await members()) - Number(before)).toBe(1);
  });
  it('expired tokens are rejected', async () => {
    const u = await mkUser('u3'); const inv = await invite(u.email);
    await sup(`update invitations set expires_at = now() - interval '1 second' where id=$1`, [inv.inv_id]);
    await rejects(user(u.id, 'select * from accept_invitation($1)', [inv.inv_token]), /invitation_invalid/);
  });
  it('revoked tokens are rejected; revoke is audited; double revoke conflicts', async () => {
    const u = await mkUser('u4'); const inv = await invite(u.email);
    await user(owner.id, 'select revoke_invitation($1)', [inv.inv_id]);
    await rejects(user(u.id, 'select * from accept_invitation($1)', [inv.inv_token]), /invitation_invalid/);
    await rejects(user(owner.id, 'select revoke_invitation($1)', [inv.inv_id]), /conflict/);
    expect((await sup(`select 1 from audit_logs where org_id=$1 and action='invitation.revoke'`, [org])).length).toBeGreaterThan(0);
  });
  it('resend rotates the token: old one dies, new one works', async () => {
    const u = await mkUser('u5'); const inv = await invite(u.email);
    const [n] = await user<{ inv_token: string }>(owner.id, 'select * from resend_invitation($1)', [inv.inv_id]);
    await rejects(user(u.id, 'select * from accept_invitation($1)', [inv.inv_token]), /invitation_invalid/);
    await user(u.id, 'select * from accept_invitation($1)', [n.inv_token]);
  });
  it('email mismatch is refused without consuming the invitation', async () => {
    const u = await mkUser('u6'); const wrong = await mkUser('w6'); const inv = await invite(u.email);
    await rejects(user(wrong.id, 'select * from accept_invitation($1)', [inv.inv_token]), /email_mismatch/);
    await user(u.id, 'select * from accept_invitation($1)', [inv.inv_token]); // still valid for the right person
  });
  it('unverified email cannot accept', async () => {
    const u = await mkUser('u7', false); const inv = await invite(u.email);
    await rejects(user(u.id, 'select * from accept_invitation($1)', [inv.inv_token]), /email_mismatch/);
  });
  it('existing member acceptance fails and does not change role', async () => {
    const u = await mkUser('u8'); const i1 = await invite(u.email, 'viewer');
    await user(u.id, 'select * from accept_invitation($1)', [i1.inv_token]);
    await sup(`update invitations set status='expired' where org_id=$1 and email=$2`, [org, u.email]);
    const manual = `manual-${Date.now()}-${Math.random()}`;   // unique per run (the DB may be persistent)
    await sup(`insert into invitations(org_id,email,role,token_hash,invited_by) values ($1,$2,'admin',sha256(convert_to($4,'UTF8')),$3)`, [org, u.email, owner.id, manual]);
    await rejects(user(u.id, `select * from accept_invitation($1)`, [manual]), /conflict/);
    expect((await sup<{ role: string }>('select role from memberships where org_id=$1 and user_id=$2', [org, u.id]))[0].role).toBe('viewer');
  });
  it('only one pending invitation per email; expired pending is replaced', async () => {
    const e = `dup-${Date.now()}@example.com`;
    const a = await invite(e);
    await rejects(invite(e), /conflict|duplicate/);
    await sup(`update invitations set expires_at = now() - interval '1 second' where id=$1`, [a.inv_id]);
    await invite(e);
  });
  it('plaintext token is never stored (invitations, audit, any column)', async () => {
    const u = await mkUser('u9'); const inv = await invite(u.email);
    const hit = await sup(`select 1 from invitations i where i::text like '%' || $1 || '%'`, [inv.inv_token]);
    const hit2 = await sup(`select 1 from audit_logs a where a::text like '%' || $1 || '%'`, [inv.inv_token]);
    expect(hit).toHaveLength(0); expect(hit2).toHaveLength(0);
    expect(inv.inv_token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
  });
  it('invalid role / email rejected', async () => {
    await rejects(invite('not-an-email'), /validation_failed/);
    await rejects(invite('ok@example.com', 'god'), /validation_failed/);
  });
});
