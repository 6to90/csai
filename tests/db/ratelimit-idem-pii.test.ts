import { describe, expect, it } from 'vitest';
import { mkOrg, mkUser, sup, svc, uniq } from './helpers';

describe('rate limiter (atomic)', () => {
  it('100 concurrent hits with limit 10 allow exactly 10', async () => {
    const key = `test:${uniq()}`;
    const res = await Promise.all(Array.from({ length: 100 }, () => svc<{ out_allowed: boolean }>('select * from rate_limit_hit($1,10,86400)', [key])));
    expect(res.filter((r) => r[0].out_allowed)).toHaveLength(10);
    const [last] = await svc<{ out_count: number; out_retry_after: number }>('select * from rate_limit_hit($1,10,86400)', [key]);
    expect(last.out_count).toBe(101); expect(last.out_retry_after).toBeGreaterThanOrEqual(1); expect(last.out_retry_after).toBeLessThanOrEqual(86400);
  });
  it('keys are independent; invalid args rejected', async () => {
    const a = `test:${uniq()}`, b = `test:${uniq()}`;
    await svc('select * from rate_limit_hit($1,1,86400)', [a]);
    expect((await svc<{ out_allowed: boolean }>('select * from rate_limit_hit($1,1,86400)', [a]))[0].out_allowed).toBe(false);
    expect((await svc<{ out_allowed: boolean }>('select * from rate_limit_hit($1,1,86400)', [b]))[0].out_allowed).toBe(true);
    await expect(svc('select * from rate_limit_hit($1,0,60)', [a])).rejects.toThrow(/validation_failed/);
  });
  it('purge removes old windows only', async () => {
    const k = `test:${uniq()}`;
    await sup(`insert into rate_limits values ($1, now() - interval '3 hours', 5), ($1, now(), 1)`, [k]);
    await svc('select purge_rate_limits()');
    expect(await sup('select 1 from rate_limits where key=$1', [k])).toHaveLength(1);
  });
});

describe('idempotency keys', () => {
  it('concurrent first calls: exactly one "new"; replay returns stored response; different body mismatches', async () => {
    const o = await mkUser('io'); const org = await mkOrg(o.id); const key = `k-${uniq()}`;
    const calls = await Promise.all(Array.from({ length: 10 }, () => svc<{ out_state: string }>('select * from idem_begin($1,$2,$3,$4)', [org, 'scope', key, 'h1'])));
    const states = calls.map((c) => c[0].out_state);
    expect(states.filter((s) => s === 'new')).toHaveLength(1);
    expect(states.filter((s) => s === 'in_progress')).toHaveLength(9);
    await svc(`select idem_finish($1,$2,$3,'{"ok":1}')`, [org, 'scope', key]);
    const [rp] = await svc<{ out_state: string; out_response: unknown }>('select * from idem_begin($1,$2,$3,$4)', [org, 'scope', key, 'h1']);
    expect(rp.out_state).toBe('replay'); expect(rp.out_response).toEqual({ ok: 1 });
    expect((await svc<{ out_state: string }>('select * from idem_begin($1,$2,$3,$4)', [org, 'scope', key, 'h2']))[0].out_state).toBe('mismatch');
  });
  it('release lets a failed request retry; stale in-progress is taken over', async () => {
    const o = await mkUser('io2'); const org = await mkOrg(o.id); const key = `k-${uniq()}`;
    await svc('select * from idem_begin($1,$2,$3,$4)', [org, 's', key, 'h']);
    await svc('select idem_release($1,$2,$3)', [org, 's', key]);
    expect((await svc<{ out_state: string }>('select * from idem_begin($1,$2,$3,$4)', [org, 's', key, 'h']))[0].out_state).toBe('new');
    await sup(`update idempotency_keys set created_at = now() - interval '10 minutes' where org_id=$1 and key=$2`, [org, key]);
    expect((await svc<{ out_state: string }>('select * from idem_begin($1,$2,$3,$4)', [org, 's', key, 'h']))[0].out_state).toBe('new');
  });
});

describe('PII retention (purge_pii)', () => {
  it('nulls webhook payloads: processed >7d, other >30d; keeps recent; deletes old done jobs', async () => {
    const o = await mkUser('po'); const org = await mkOrg(o.id);
    const [ch] = await sup<{ id: string }>(`insert into channel_accounts(org_id,kind,name) values ($1,'email','m') returning id`, [org]);
    const ins = (id: string, status: string, age: string) =>
      sup(`insert into webhook_events(org_id,channel_account_id,provider,external_event_id,payload,status,received_at) values ($1,$2,'email',$3,'{"from":"a@b.c","body":"hello"}',$4, now() - $5::interval)`, [org, ch.id, id, status, age]);
    await ins('old-ok', 'processed', '8 days'); await ins('new-ok', 'processed', '1 day');
    await ins('old-fail', 'failed', '31 days'); await ins('mid-fail', 'failed', '10 days');
    await sup(`insert into jobs(org_id,type,dedupe_key,status,finished_at) values ($1,'t','old','done', now() - interval '31 days'), ($1,'t','new','done', now())`, [org]);
    await svc('select * from purge_pii()');
    const rows = Object.fromEntries((await sup<{ external_event_id: string; payload: unknown }>('select external_event_id, payload from webhook_events where org_id=$1', [org])).map((r) => [r.external_event_id, r.payload]));
    expect(rows['old-ok']).toBeNull(); expect(rows['old-fail']).toBeNull();
    expect(rows['new-ok']).not.toBeNull(); expect(rows['mid-fail']).not.toBeNull();
    expect((await sup('select 1 from jobs where org_id=$1', [org])).length).toBe(1);
  });
  it('webhook events dedupe per (org, channel, event id) but not across orgs', async () => {
    const [o1, o2] = await Promise.all([mkUser('w1'), mkUser('w2')]);
    const [a, b] = await Promise.all([mkOrg(o1.id), mkOrg(o2.id)]);
    const chan = async (org: string) => (await sup<{ id: string }>(`insert into channel_accounts(org_id,kind,name) values ($1,'email','m') returning id`, [org]))[0].id;
    const [ca, cb] = [await chan(a), await chan(b)];
    const ins = (org: string, ch: string) => sup(`insert into webhook_events(org_id,channel_account_id,provider,external_event_id) values ($1,$2,'email','same-message-id')`, [org, ch]);
    await ins(a, ca); await ins(b, cb);                                       // same Message-ID, two orgs: both kept
    await expect(ins(a, ca)).rejects.toThrow(/duplicate key/);                // replay in same org: rejected
    await expect(ins(a, cb)).rejects.toThrow(/foreign key/);                  // channel of another org: rejected
  });
});
