import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, mkOrg, mkUser, rejects, sup, user } from './helpers';

type U = { id: string; email: string };
let owner: U, admin: U, agent: U, viewer: U, outsider: U, org: string;
let mAdmin: string, mAgent: string, mViewer: string, mOwner: string;

beforeAll(async () => {
  [owner, admin, agent, viewer, outsider] = await Promise.all(['owner', 'admin', 'agent', 'viewer', 'out'].map((l) => mkUser(l)));
  org = await mkOrg(owner.id);
  mOwner = (await sup<{ id: string }>('select id from memberships where org_id=$1 and user_id=$2', [org, owner.id]))[0].id;
  mAdmin = await addMember(org, owner.id, admin, 'admin');
  mAgent = await addMember(org, owner.id, agent, 'agent');
  mViewer = await addMember(org, owner.id, viewer, 'viewer');
});
const roleOf = async (id: string) => (await sup<{ role: string }>('select role from memberships where id=$1', [id]))[0].role;

describe('privilege escalation is blocked', () => {
  it('members cannot write memberships directly', async () => {
    await rejects(user(agent.id, `update memberships set role='owner' where id=$1`, [mAgent]), /permission denied/);
    await rejects(user(agent.id, `insert into memberships(org_id,user_id,role) values ($1,$2,'owner')`, [org, outsider.id]), /permission denied/);
    await rejects(user(admin.id, `delete from memberships where id=$1`, [mAgent]), /permission denied/);
  });
  it('agent/viewer cannot invite, change roles, remove, or edit the org', async () => {
    for (const u of [agent, viewer]) {
      await rejects(user(u.id, 'select * from create_invitation($1,$2,$3)', [org, 'z@example.com', 'viewer']), /forbidden/);
      await rejects(user(u.id, 'select set_member_role($1,$2)', [mViewer, 'admin']), /forbidden/);
      await rejects(user(u.id, 'select remove_member($1)', [mViewer]), /forbidden/);
      await rejects(user(u.id, `update organizations set kill_switch=true where id=$1 returning id`, [org]), /permission denied/);
      await rejects(user(u.id, 'select update_organization($1,$2)', [org, 'x']), /forbidden/);
    }
  });
  it('a member cannot promote themselves', async () => {
    await rejects(user(agent.id, 'select set_member_role($1,$2)', [mAgent, 'admin']), /forbidden/);
    await rejects(user(admin.id, 'select set_member_role($1,$2)', [mAdmin, 'agent']), /forbidden/); // no self-change
    expect(await roleOf(mAgent)).toBe('agent');
  });
  it('admin cannot invite admins, cannot promote to admin, cannot touch admins/owner', async () => {
    await rejects(user(admin.id, 'select * from create_invitation($1,$2,$3)', [org, 'a2@example.com', 'admin']), /forbidden/);
    await rejects(user(admin.id, 'select set_member_role($1,$2)', [mAgent, 'admin']), /forbidden/);
    await rejects(user(admin.id, 'select set_member_role($1,$2)', [mOwner, 'viewer']), /forbidden/);
    await rejects(user(admin.id, 'select remove_member($1)', [mOwner]), /forbidden/);
  });
  it('owner role cannot be assigned, changed or removed; invitations cannot grant owner', async () => {
    await rejects(user(owner.id, 'select set_member_role($1,$2)', [mAgent, 'owner']), /validation_failed/);
    await rejects(user(owner.id, 'select * from create_invitation($1,$2,$3)', [org, 'o2@example.com', 'owner']), /validation_failed/);
    await rejects(user(owner.id, 'select remove_member($1)', [mOwner]), /forbidden/);
  });
  it('admin may manage agent/viewer; owner may manage admin', async () => {
    await user(admin.id, 'select set_member_role($1,$2)', [mViewer, 'agent']);
    expect(await roleOf(mViewer)).toBe('agent');
    await user(owner.id, 'select set_member_role($1,$2)', [mAdmin, 'agent']);
    expect(await roleOf(mAdmin)).toBe('agent');
    await user(owner.id, 'select set_member_role($1,$2)', [mAdmin, 'admin']);
  });
  it('service-level RPCs/functions are not callable by users', async () => {
    for (const q of ['select claim_jobs($1,1)', `select rate_limit_hit($1,1,60)`, `select enqueue_job(gen_random_uuid(),$1,'{}',$1)`, 'select purge_pii()'])
      await rejects(user(agent.id, q, q.includes('purge') ? [] : ['x']), /permission denied/);
  });
  it('cannot invite an existing member', async () => {
    await rejects(user(owner.id, 'select * from create_invitation($1,$2,$3)', [org, agent.email, 'viewer']), /conflict/);
  });
  it('org settings change only through the audited RPC; direct update/delete is revoked for everyone incl. owner', async () => {
    for (const u of [owner, admin]) {
      await rejects(user(u.id, `update organizations set slug='hijack-it' where id=$1`, [org]), /permission denied/);
      await rejects(user(u.id, 'delete from organizations where id=$1', [org]), /permission denied/);
    }
    await user(admin.id, 'select update_organization($1,$2,$3)', [org, 'Renamed', 90]);
    expect((await sup<{ name: string; data_retention_days: number }>('select name,data_retention_days from organizations where id=$1', [org]))[0]).toEqual({ name: 'Renamed', data_retention_days: 90 });
    expect((await sup(`select 1 from audit_logs where org_id=$1 and action='org.update' and metadata->>'fields'='name,data_retention_days'`, [org])).length).toBe(1);
    await rejects(user(admin.id, 'select update_organization($1)', [org]), /validation_failed/);
    await rejects(user(admin.id, 'select update_organization($1,null,5)', [org]), /check|violates/);
  });
  it('integrations / channel_accounts: users have no direct write path yet', async () => {
    await rejects(user(owner.id, `insert into integrations(org_id,kind,name) values ($1,'http_connector','x')`, [org]), /permission denied/);
    await rejects(user(owner.id, `insert into channel_accounts(org_id,kind,name) values ($1,'email','x')`, [org]), /permission denied/);
  });
  it('role changes are audited', async () => {
    const a = await sup<{ action: string }>(`select action from audit_logs where org_id=$1 and action='member.role_change'`, [org]);
    expect(a.length).toBeGreaterThanOrEqual(2);
  });
});
