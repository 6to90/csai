import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The ONLY place the service_role key is read (CLAUDE.md §5). Bypasses RLS: callers MUST enforce authz and pass org_id explicitly.
let client: SupabaseClient | undefined;
export function systemClient(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase service configuration missing');
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}
