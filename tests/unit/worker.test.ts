import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError, runJobs, type JobRow, type JobsDb } from '@/server/jobs/worker';

const job = (type: string, id = 'j1'): JobRow => ({ id, org_id: 'o', type, payload: {}, attempts: 1, max_attempts: 5 });
function fakeDb(jobs: JobRow[], failStatus = 'failed', completeOk = true) {
  const calls: string[] = [];
  const db: JobsDb = {
    async claim() { return jobs; },
    async complete(id) { calls.push(`complete:${id}`); return completeOk; },
    async fail(id, _w, err, retryable) { calls.push(`fail:${id}:${retryable}:${err}`); return retryable ? failStatus : 'dead'; },
    async heartbeat() { return true; },
  };
  return { db, calls };
}
describe('runJobs', () => {
  it('completes successful jobs', async () => {
    const { db, calls } = fakeDb([job('a')]);
    expect(await runJobs(db, { a: async () => {} }, { worker: 'w' })).toMatchObject({ claimed: 1, done: 1 });
    expect(calls).toEqual(['complete:j1']);
  });
  it('unknown job types are non-retryable (dead), not retried forever', async () => {
    const { db, calls } = fakeDb([job('nope')]);
    expect(await runJobs(db, {}, { worker: 'w' })).toMatchObject({ dead: 1 });
    expect(calls[0]).toMatch(/^fail:j1:false:/);
  });
  it('handler errors are retryable; NonRetryableError is not', async () => {
    const r1 = fakeDb([job('a')]); expect(await runJobs(r1.db, { a: async () => { throw new Error('boom'); } }, { worker: 'w' })).toMatchObject({ retried: 1 });
    const r2 = fakeDb([job('a')]); expect(await runJobs(r2.db, { a: async () => { throw new NonRetryableError('bad'); } }, { worker: 'w' })).toMatchObject({ dead: 1 });
  });
  it('handler timeout aborts and fails the job as retryable', async () => {
    const { db, calls } = fakeDb([job('slow')]);
    const res = await runJobs(db, { slow: () => new Promise(() => {}) }, { worker: 'w', handlerTimeoutMs: 20 });
    expect(res.retried).toBe(1); expect(calls[0]).toContain('handler timeout');
  });
  it('a lost lease is reported as lost, not done', async () => {
    const { db } = fakeDb([job('a')], 'failed', false);
    expect(await runJobs(db, { a: async () => {} }, { worker: 'w' })).toMatchObject({ done: 0, lost: 1 });
  });
  it('one failing job does not stop the batch; heartbeat runs for long handlers', async () => {
    const { db, calls } = fakeDb([job('bad', 'j1'), job('ok', 'j2')]);
    const hb = vi.spyOn(db, 'heartbeat');
    const res = await runJobs(db, { bad: async () => { throw new Error('x'); }, ok: () => new Promise<void>((r) => setTimeout(r, 40)) }, { worker: 'w', heartbeatMs: 10 });
    expect(res).toMatchObject({ claimed: 2, done: 1, retried: 1 }); expect(calls).toContain('complete:j2'); expect(hb).toHaveBeenCalled();
  });
});
