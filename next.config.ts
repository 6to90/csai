import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = {
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR || '.next',   // lets a second dev server run beside another one (separate cache/lock)
  // Build-time constant (inlined into the bundle): only a build made with CSAI_TEST_BUILD=1 can ever honour SMTP_ALLOW_PRIVATE_HOSTS.
  // A production build leaves it empty, so no runtime environment variable can switch the SSRF guard off there. See src/server/security/net-guard.ts.
  env: { CSAI_TEST_BUILD: process.env.CSAI_TEST_BUILD === '1' ? '1' : '' },
  async rewrites() { return [{ source: '/widget/v1.js', destination: '/widget.js' }]; },
  outputFileTracingRoot: path.resolve(process.cwd()),
  async headers() {
    // /widget.js = latest (revalidates every minute, stale copy allowed for 10 more minutes while it refreshes). /widget/v1.js = the v1 compatibility line (1 h).
    return [{ source: '/widget.js', headers: [{ key: 'Cache-Control', value: 'public, max-age=60, stale-while-revalidate=600' }, { key: 'X-Content-Type-Options', value: 'nosniff' }] }, { source: '/widget/v1.js', headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=600' }, { key: 'X-Content-Type-Options', value: 'nosniff' }] }, { source: '/(.*)', headers: [
      // CSP/HSTS/Permissions-Policy are set per request in src/proxy.ts. These cover responses the proxy does not see (static assets).
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ] }];
  },
};
export default config;
