import { log } from '../log';

export interface JobRow { id: string; org_id: string; type: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }
export interface JobsDb {
  claim(worker: string, limit: number): Promise<JobRow[]>;
  complete(id: string, worker: string): Promise<boolean>;
  fail(id: string, worker: string, error: string, retryable: boolean): Promise<string>;
  heartbeat(id: string, worker: string): Promise<boolean>;
}
export class NonRetryableError extends Error {}
export type Handlers = Record<string, (job: JobRow, signal: AbortSignal) => Promise<void>>;
export interface RunResult { claimed: number; done: number; retried: number; dead: number; lost: number }

/**
 * At-least-once execution: handlers MUST be idempotent (DATABASE §6). Completion/failure are fenced by locked_by in SQL,
 * so a worker that lost its lease cannot overwrite the result of the worker that re-claimed the job.
 */
export async function runJobs(db: JobsDb, handlers: Handlers, o: { worker: string; limit?: number; handlerTimeoutMs?: number; heartbeatMs?: number }): Promise<RunResult> {
  const res: RunResult = { claimed: 0, done: 0, retried: 0, dead: 0, lost: 0 };
  const jobs = await db.claim(o.worker, o.limit ?? 10);
  res.claimed = jobs.length;
  for (const job of jobs) {
    const handler = handlers[job.type];
    const ac = new AbortController();
    const hb = setInterval(() => void db.heartbeat(job.id, o.worker).catch(() => {}), o.heartbeatMs ?? 30_000);
    const timer = setTimeout(() => ac.abort(), o.handlerTimeoutMs ?? 90_000);
    try {
      if (!handler) throw new NonRetryableError(`no handler for job type ${job.type}`);
      await Promise.race([
        handler(job, ac.signal),
        new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('handler timeout')))),
      ]);
      if (await db.complete(job.id, o.worker)) res.done++; else res.lost++;
    } catch (e) {
      const retryable = !(e instanceof NonRetryableError);
      const status = await db.fail(job.id, o.worker, e instanceof Error ? e.message : 'error', retryable);
      if (status === 'dead') res.dead++; else if (status === 'failed') res.retried++; else res.lost++;
      log('warn', 'job failed', { jobId: job.id, type: job.type, status, err: e });
    } finally { clearTimeout(timer); clearInterval(hb); }
  }
  return res;
}
