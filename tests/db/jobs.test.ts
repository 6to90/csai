import { describe, expect, it } from 'vitest';
import { mkOrg, mkUser, sup, svc } from './helpers';

const setup = async () => { const o = await mkUser('jo'); return mkOrg(o.id); };
const enqueue = async (org: string, key: string, maxAttempts = 5) =>
  (await svc<{ enqueue_job: string | null }>(`select enqueue_job($1,'test',$2,$3,now(),$4)`, [org, '{}', key, maxAttempts]))[0].enqueue_job;
const claim = (w: string, n = 10) => svc<{ id: string; attempts: number }>('select * from claim_jobs($1,$2)', [w, n]);
const expireLease = (id: string) => sup(`update jobs set locked_until = now() - interval '1 second' where id=$1`, [id]);
const job = async (id: string) => (await sup<{ status: string; attempts: number; run_at: Date; locked_by: string | null }>('select * from jobs where id=$1', [id]))[0];

describe('job queue', () => {
  it('dedupe_key prevents duplicate enqueue; max_attempts is capped at 5', async () => {
    const org = await setup();
    expect(await enqueue(org, 'k1')).toBeTruthy();
    expect(await enqueue(org, 'k1')).toBeNull();
    const id = await enqueue(org, 'k2', 99);
    expect((await sup<{ max_attempts: number }>('select max_attempts from jobs where id=$1', [id]))[0].max_attempts).toBe(5);
  });

  it('concurrent workers never claim the same job', async () => {
    const org = await setup();
    const ids = await Promise.all(Array.from({ length: 40 }, (_, i) => enqueue(org, `c${i}`)));
    const claimedSets = await Promise.all(Array.from({ length: 8 }, (_, w) => claim(`w${w}`, 10)));
    const all = claimedSets.flat().map((j) => j.id).filter((id) => ids.includes(id));
    expect(all).toHaveLength(new Set(all).size);   // no duplicates
    expect(new Set(all).size).toBe(40);            // nothing lost
    expect((await sup<{ attempts: number }>('select attempts from jobs where org_id=$1', [org])).every((r) => r.attempts === 1)).toBe(true);
  });

  it('recovers a job whose worker died (expired lease) and fences the stale worker', async () => {
    const org = await setup(); const id = (await enqueue(org, 'r1'))!;
    expect((await claim('w1')).map((j) => j.id)).toContain(id);
    expect((await claim('w2')).map((j) => j.id)).not.toContain(id);       // lease still valid
    await expireLease(id);
    const re = await claim('w2');
    expect(re.find((j) => j.id === id)?.attempts).toBe(2);                 // reclaimed
    expect((await svc<{ complete_job: boolean }>('select complete_job($1,$2)', [id, 'w1']))[0].complete_job).toBe(false); // stale worker fenced
    expect((await svc<{ fail_job: string }>(`select fail_job($1,'w1','late',true)`, [id]))[0].fail_job).toBe('lost');
    expect((await svc<{ complete_job: boolean }>('select complete_job($1,$2)', [id, 'w2']))[0].complete_job).toBe(true);
    expect((await job(id)).status).toBe('done');
  });

  it('exhausted lease-expired jobs go dead (reaper) and are audited', async () => {
    const org = await setup(); const id = (await enqueue(org, 'd1', 2))!;
    await claim('w1'); await expireLease(id);
    await claim('w2'); await expireLease(id);                              // attempts == max
    expect((await claim('w3')).map((j) => j.id)).not.toContain(id);
    expect((await job(id)).status).toBe('dead');
    expect((await sup(`select 1 from audit_logs where org_id=$1 and action='job.dead'`, [org])).length).toBe(1);
  });

  it('retries with exponential backoff + jitter, then dies after max_attempts', async () => {
    const org = await setup(); const id = (await enqueue(org, 'b1'))!;
    const base = [30, 60, 120, 240];
    for (let n = 1; n <= 5; n++) {
      expect((await claim('w')).map((j) => j.id)).toContain(id);
      const before = Date.now();
      const status = (await svc<{ fail_job: string }>(`select fail_job($1,'w','boom',true)`, [id]))[0].fail_job;
      if (n < 5) {
        expect(status).toBe('failed');
        const delay = ((await job(id)).run_at.getTime() - before) / 1000;
        expect(delay).toBeGreaterThan(base[n - 1] * 0.75); expect(delay).toBeLessThan(base[n - 1] * 1.25);
        expect((await claim('w')).map((j) => j.id)).not.toContain(id);     // not due yet
        await sup(`update jobs set run_at = now() where id=$1`, [id]);
      } else expect(status).toBe('dead');
    }
    expect((await job(id)).attempts).toBe(5);
    expect((await claim('w')).map((j) => j.id)).not.toContain(id);
  });

  it('non-retryable failure is dead immediately', async () => {
    const org = await setup(); const id = (await enqueue(org, 'n1'))!;
    await claim('w');
    expect((await svc<{ fail_job: string }>(`select fail_job($1,'w','bad input',false)`, [id]))[0].fail_job).toBe('dead');
  });

  it('heartbeat extends the lease only for the owner', async () => {
    const org = await setup(); const id = (await enqueue(org, 'h1'))!;
    await claim('w1');
    expect((await svc<{ heartbeat_job: boolean }>('select heartbeat_job($1,$2)', [id, 'w2']))[0].heartbeat_job).toBe(false);
    expect((await svc<{ heartbeat_job: boolean }>('select heartbeat_job($1,$2)', [id, 'w1']))[0].heartbeat_job).toBe(true);
  });
});
