import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobsDb, JobRow } from './worker';

/** service_role client only. NOTE: RPC wiring not yet verified against a live PostgREST (SQL itself is tested directly). */
export function supabaseJobsDb(db: SupabaseClient): JobsDb {
  const ck = (e: { message: string } | null) => { if (e) throw new Error(`jobs db: ${e.message}`); };
  return {
    async claim(worker, limit) { const { data, error } = await db.rpc('claim_jobs', { p_worker: worker, p_limit: limit }); ck(error); return (data ?? []) as JobRow[]; },
    async complete(id, worker) { const { data, error } = await db.rpc('complete_job', { p_id: id, p_worker: worker }); ck(error); return data === true; },
    async fail(id, worker, err, retryable) { const { data, error } = await db.rpc('fail_job', { p_id: id, p_worker: worker, p_error: err, p_retryable: retryable }); ck(error); return data as string; },
    async heartbeat(id, worker) { const { data, error } = await db.rpc('heartbeat_job', { p_id: id, p_worker: worker }); ck(error); return data === true; },
  };
}
