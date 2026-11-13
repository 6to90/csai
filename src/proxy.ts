import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { securityHeaders } from '@/lib/security-headers';

const withHeaders = (res: NextResponse, h: Record<string, string>) => { for (const [k, v] of Object.entries(h)) res.headers.set(k, v); return res; };

// 1) security headers (per-request CSP nonce) on every page/API response, 2) session refresh + coarse guard for /dashboard and /login.
// The guard is NOT the only one: dashboard/layout.tsx re-checks on the server (defense in depth).
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const opts = {
    nonce: Buffer.from(crypto.randomUUID()).toString('base64'),
    isDev: process.env.NODE_ENV !== 'production',
    https: (process.env.APP_URL ?? '').startsWith('https://'),
    supabaseOrigin: new URL(supabaseUrl).origin,
  };
  if (pathname.startsWith('/api/')) return withHeaders(NextResponse.next(), securityHeaders(opts, true));

  const headers = securityHeaders(opts);
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set('x-nonce', opts.nonce);                       // Next.js applies the nonce found in the request CSP to its own scripts
  reqHeaders.set('content-security-policy', headers['Content-Security-Policy']);
  let res = NextResponse.next({ request: { headers: reqHeaders } });

  if (pathname.startsWith('/dashboard') || pathname === '/login' || pathname === '/signup') {
    const supabase = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (all) => {
          all.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: { headers: reqHeaders } });
          all.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        },
      },
    });
    const { data } = await supabase.auth.getUser(); // server-validated, not just a decoded cookie
    if (!data.user && pathname.startsWith('/dashboard')) {
      const url = req.nextUrl.clone(); url.pathname = '/login'; url.search = `?next=${encodeURIComponent(pathname)}`;
      return withHeaders(NextResponse.redirect(url), headers);
    }
    if (data.user && (pathname === '/login' || pathname === '/signup')) {
      const url = req.nextUrl.clone(); url.pathname = '/dashboard'; url.search = '';
      return withHeaders(NextResponse.redirect(url), headers);
    }
  }
  return withHeaders(res, headers);
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
