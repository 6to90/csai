import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = {
  poweredByHeader: false,
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
