import { createBrowserClient } from '@supabase/ssr';

// Browser: anon key only. The service_role key must never reach this bundle.
export const createBrowser = () =>
  createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
