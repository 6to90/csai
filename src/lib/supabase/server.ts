import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const url = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** User-scoped client from the session cookie. RLS applies. */
export async function createCookieClient() {
  const store = await cookies();
  return createServerClient(url(), anon(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (all) => { try { all.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* called from a Server Component */ } },
    },
  });
}
/** User-scoped client from a Bearer token (API clients). RLS applies. */
export const createBearerClient = (token: string) =>
  createClient(url(), anon(), { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
