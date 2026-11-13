import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, mkOrg, mkUser, rejects, sup, user, userAal1 } from './helpers';

type U = { id: string; email: string };
let owner: U, admin: U, agent: U, org: string, agentMember: string;

beforeAll(async () => {
  [owner, admin, agent] = await Promise.all(['mowner', 'madmin', 'magent'].map((l) => mkUser(l)));
  org = await mkOrg(owner.id);                                    // all setup is done with aal2 sessions
  await addMember(org, owner.id, admin, 'admin'); await addMember(org, owner.id, agent, 'agent');
  agentMember = (await sup<{ id: string }>('select id from memberships where org_id=$1 and user_id=$2', [org, agent.id]))[0].id;
});

describe('owner/admin without MFA (aal1) cannot use privileged RPCs', () => {
  it.each(['owner', 'admin'] as const)('%s at aal1: every privileged RPC raises mfa_required', async (who) => {
    const u = who === 'owner' ? owner : admin;
    await rejects(userAal1(u.id, 'select * from create_invitation($1,$2,$3)', [org, `x-${who}@example.com`, 'viewer']), /mfa_required/);
    await rejects(userAal1(u.id, 'select set_member_role($1,$2)', [agentMember, 'viewer']), /mfa_required/);
    await rejects(userAal1(u.id, 'select remove_member($1)', [agentMember]), /mfa_required/);
    await rejects(userAal1(u.id, 'select update_organization($1,$2)', [org, 'nope']), /mfa_required/);
    const [inv] = await user<{ inv_id: string }>(owner.id, 'select * from create_invitation($1,$2,$3)', [org, `pending-${who}@example.com`, 'viewer']);
    await rejects(userAal1(u.id, 'select revoke_invitation($1)', [inv.inv_id]), /mfa_required/);
    await rejects(userAal1(u.id, 'select * from resend_invitation($1)', [inv.inv_id]), /mfa_required/);
    expect((await sup('select 1 from audit_logs where org_id=$1 and action=$2 and actor_id=$3', [org, 'invitation.revoke', u.id])).length).toBe(0);   // nothing slipped through
  });
  it('RLS: admin-only reads disappear at aal1 (audit log, invitations, other members) but membership basics remain', async () => {
    expect(await userAal1(owner.id, 'select 1 from audit_logs where org_id=$1', [org])).toHaveLength(0);
    expect(await userAal1(owner.id, 'select 1 from invitations where org_id=$1', [org])).toHaveLength(0);
    expect(await userAal1(admin.id, 'select 1 from memberships where org_id=$1', [org])).toHaveLength(1);   // only own row
    expect((await userAal1(owner.id, 'select id from organizations where id=$1', [org])).length).toBe(1);   // still a member
    expect((await user(owner.id, 'select 1 from audit_logs where org_id=$1', [org])).length).toBeGreaterThan(0);        // aal2: visible
    expect((await user(owner.id, 'select 1 from memberships where org_id=$1', [org])).length).toBe(3);
  });
  it('a missing aal claim counts as aal1 (fail closed)', async () => {
    const { pool } = await import('./helpers');
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: owner.id, role: 'authenticated' })]);
      await expect(c.query('select * from create_invitation($1,$2,$3)', [org, 'noaal@example.com', 'viewer'])).rejects.toThrow(/mfa_required/);
    } finally { await c.query('rollback'); c.release(); }
  });
});

describe('MFA does not burden other roles or onboarding', () => {
  it('agent at aal1 is unaffected (and still not privileged)', async () => {
    expect((await userAal1(agent.id, 'select id from organizations where id=$1', [org])).length).toBe(1);
    await rejects(userAal1(agent.id, 'select * from create_invitation($1,$2,$3)', [org, 'a@example.com', 'viewer']), /forbidden/);   // role check, not mfa
  });
  it('sign-in-level actions work at aal1: create org, accept invitation, non-member probing', async () => {
    const fresh = await mkUser('fresh');
    const id = (await userAal1<{ create_organization: string }>(fresh.id, 'select create_organization($1,$2)', ['Fresh', `fresh-${Date.now()}`]))[0].create_organization;
    expect(id).toBeTruthy();
    await rejects(userAal1(fresh.id, 'select * from create_invitation($1,$2,$3)', [id, 'y@example.com', 'viewer']), /mfa_required/);   // becomes owner => must complete MFA first
    const joiner = await mkUser('joiner'); const [inv] = await user<{ inv_token: string }>(owner.id, 'select * from create_invitation($1,$2,$3)', [org, joiner.email, 'viewer']);
    expect((await userAal1(joiner.id, 'select * from accept_invitation($1)', [inv.inv_token])).length).toBe(1);
    const outsider = await mkUser('outsider');
    await rejects(userAal1(outsider.id, 'select * from create_invitation($1,$2,$3)', [org, 'z@example.com', 'viewer']), /forbidden/);   // non-members learn nothing about MFA
  });
  it('aal2 admin/owner can do everything as before', async () => {
    await user(admin.id, 'select update_organization($1,$2)', [org, 'MFA Org']);
    await user(owner.id, 'select set_member_role($1,$2)', [agentMember, 'viewer']);
    await user(owner.id, 'select set_member_role($1,$2)', [agentMember, 'agent']);
  });
  it('helper functions are not callable by app users', async () => {
    await rejects(user(owner.id, 'select assert_aal2_if_privileged($1)', [org]), /permission denied/);
  });
});
