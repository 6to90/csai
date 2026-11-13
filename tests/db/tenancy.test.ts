import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, mkOrg, mkUser, rejects, sup, svc, user, as } from './helpers';

let alice: { id: string; email: string }, bob: { id: string; email: string }, carol: { id: string; email: string };
let orgA: string, orgB: string;

beforeAll(async () => {
  alice = await mkUser('alice'); bob = await mkUser('bob'); carol = await mkUser('carol');
  orgA = await mkOrg(alice.id, 'A'); orgB = await mkOrg(bob.id, 'B');
  await addMember(orgA, alice.id, carol, 'agent');
  // data in org B
  await user(bob.id, `insert into customers(org_id, display_name) values ($1,'B-customer')`, [orgB]);
  await sup(`insert into channel_accounts(org_id, kind, name) values ($1,'web_chat','B-chat')`, [orgB]);   // users have no direct write (audited RPCs arrive in Phase 3)
  await sup(`insert into integrations(org_id, kind, name) values ($1,'http_connector','B-int')`, [orgB]);
  await user(bob.id, 'select * from create_invitation($1,$2,$3)', [orgB, 'x@example.com', 'agent']);
});

describe('tenant isolation (RLS)', () => {
  it.each(['organizations', 'memberships', 'customers', 'channel_accounts', 'conversations', 'integrations', 'audit_logs'])(
    'alice (org A owner) sees no org B rows in %s', async (t) => {
      const col = t === 'organizations' ? 'id' : 'org_id';
      expect(await user(alice.id, `select 1 from ${t} where ${col} = $1`, [orgB])).toHaveLength(0);
    });
  it('alice cannot see org B invitations', async () => {
    expect(await user(alice.id, 'select id from invitations where org_id = $1', [orgB])).toHaveLength(0);
  });
  it('alice cannot insert into org B', async () => {
    await rejects(user(alice.id, `insert into customers(org_id, display_name) values ($1,'x')`, [orgB]), /row-level security/);
    await rejects(user(alice.id, `insert into channel_accounts(org_id, kind, name) values ($1,'email','x')`, [orgB]), /permission denied/);
  });
  it('alice cannot update or delete org B rows (0 rows affected)', async () => {
    await rejects(user(alice.id, `update organizations set name='pwn' where id=$1 returning id`, [orgB]), /permission denied/);
    expect(await user(alice.id, `delete from customers where org_id=$1 returning id`, [orgB])).toHaveLength(0);
    expect(await user(alice.id, `update customers set display_name='pwn' where org_id=$1 returning id`, [orgB])).toHaveLength(0);
    expect((await sup<{ name: string }>('select name from organizations where id=$1', [orgB]))[0].name).toBe('B');
  });
  it('alice cannot act through RPCs on org B', async () => {
    await rejects(user(alice.id, 'select * from create_invitation($1,$2,$3)', [orgB, 'evil@example.com', 'viewer']), /forbidden/);
  });
  it('composite FK blocks cross-tenant references', async () => {
    const [cust] = await sup<{ id: string }>(`select id from customers where org_id=$1`, [orgB]);
    const [ch] = await sup<{ id: string }>(`select id from channel_accounts where org_id=$1`, [orgA]).then(async (r) => r.length ? r : sup<{ id: string }>(`insert into channel_accounts(org_id,kind,name) values ($1,'web_chat','A') returning id`, [orgA]));
    await rejects(sup(`insert into conversations(org_id, channel_account_id, customer_id) values ($1,$2,$3)`, [orgA, ch.id, cust.id]), /foreign key/);
  });
  it('every public table has RLS enabled and forced', async () => {
    const r = await sup<{ relname: string }>(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not (c.relrowsecurity and c.relforcerowsecurity)`);
    expect(r).toEqual([]);
  });
});

describe('service-only tables are unreachable for app roles', () => {
  const only = ['org_keys', 'integration_secrets', 'jobs', 'rate_limits', 'chat_sessions', 'webhook_events', 'idempotency_keys'];
  it.each(only)('%s: authenticated and anon are denied', async (t) => {
    await rejects(user(alice.id, `select * from ${t}`), /permission denied/);
    await rejects(as('anon', null, `select * from ${t}`), /permission denied/);
  });
  it('anon cannot read any tenant table', async () => {
    for (const t of ['organizations', 'memberships', 'customers', 'audit_logs']) await rejects(as('anon', null, `select * from ${t}`), /permission denied/);
  });
  it('invitation token_hash is not selectable', async () => {
    await rejects(user(bob.id, 'select token_hash from invitations'), /permission denied/);
    await rejects(user(bob.id, 'select * from invitations'), /permission denied/);
    expect((await user(bob.id, 'select id, email, status from invitations where org_id=$1', [orgB])).length).toBeGreaterThan(0);
  });
});

describe('audit log is append-only', () => {
  it('records org creation and member events', async () => {
    const rows = await sup<{ action: string }>('select action from audit_logs where org_id=$1', [orgA]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['org.create', 'invitation.create', 'invitation.accept']));
  });
  it('app roles cannot insert; append_audit is not callable by users', async () => {
    await rejects(user(alice.id, `insert into audit_logs(org_id, actor_type, action) values ($1,'user','x')`, [orgA]), /permission denied/);
    await rejects(user(alice.id, `select append_audit($1,'user',null,'x','t','1')`, [orgA]), /permission denied/);
  });
  it('nobody (incl. service_role and superuser) can update, delete or truncate', async () => {
    await rejects(svc(`update audit_logs set action='x'`), /permission denied/);
    await rejects(svc(`delete from audit_logs`), /permission denied/);
    await rejects(svc(`truncate audit_logs`), /permission denied/);
    await rejects(sup(`update audit_logs set action='x'`), /append-only/);
    await rejects(sup(`delete from audit_logs`), /append-only/);
    await rejects(sup(`truncate audit_logs`), /append-only/);
  });
  it('metadata is allowlisted per action: unknown action/key, nested, free text, emails, long values are rejected', async () => {
    const put = (action: string, meta: string) => svc(`select append_audit($1,'system',null,$2,null,null,$3::jsonb)`, [orgA, action, meta]);
    await rejects(put('x', '{}'), /not allowed/);                                            // unregistered action
    await rejects(put('invitation.create', '{"token":"abc"}'), /not allowed/);               // unregistered key
    await rejects(put('invitation.create', '{"role":{"a":1}}'), /not allowed/);              // nested
    await rejects(put('invitation.create', '{"role":["admin"]}'), /not allowed/);            // array
    await rejects(put('invitation.create', '{"role":"alice@example.com"}'), /not allowed/);  // not identifier-like
    await rejects(put('invitation.create', '{"role":"free text with spaces"}'), /not allowed/);
    await rejects(put('invitation.create', `{"role":"${'a'.repeat(65)}"}`), /not allowed/);  // too long
    await rejects(put('invitation.create', 'null'), /not allowed/);
    await put('invitation.create', '{"role":"agent"}');                                       // allowed
    await put('job.dead', '{"type":"process_inbound","reason":"lease_expired","retryable":false}');
  });
  it('every public function is default-deny: users may only execute the whitelisted RPCs', async () => {
    const rows = await sup<{ proname: string }>(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`);
    expect(rows.map((r) => r.proname)).toEqual(['accept_invitation','create_channel_account','create_invitation','create_organization','end_chat','has_role','is_aal2','is_member','list_members','mark_conversation_read','prepare_widget_secret','remove_member','resend_invitation','retry_message','revoke_invitation','send_reply','set_channel_status','set_member_role','shares_org_with','update_conversation','update_organization','update_widget']);
    const anon = await sup<{ proname: string }>(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(anon).toEqual([]);
  });
  it('viewer/agent cannot read the audit log; owner can', async () => {
    expect(await user(carol.id, 'select 1 from audit_logs where org_id=$1', [orgA])).toHaveLength(0);
    expect((await user(alice.id, 'select 1 from audit_logs where org_id=$1', [orgA])).length).toBeGreaterThan(0);
  });
});
