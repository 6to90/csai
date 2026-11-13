// Security headers (CSP/HSTS/Permissions-Policy). Pure functions so they can be unit-tested; applied by src/proxy.ts.
const TURNSTILE = 'https://challenges.cloudflare.com';

export interface HeaderOpts { nonce: string; isDev: boolean; https: boolean; supabaseOrigin: string }

/** Page CSP: nonce-based scripts ('strict-dynamic' lets our nonced bundle load Turnstile); no 'unsafe-inline'/'unsafe-eval' in production. */
export function buildCsp({ nonce, isDev, https, supabaseOrigin }: HeaderOpts): string {
  const d: string[] = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE}${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-inline'" : ''}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${supabaseOrigin} ${supabaseOrigin.replace(/^http/, 'ws')}${isDev ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    `frame-src ${TURNSTILE}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https && !isDev) d.push('upgrade-insecure-requests');
  return d.join('; ');
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export function securityHeaders(o: HeaderOpts, api = false): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': api ? API_CSP : buildCsp(o),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // No camera/mic/geolocation/payment today. The future voice channel will need microphone=(self) — change it deliberately then.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
  };
  // HSTS only where the app is served over HTTPS (browsers ignore it on http, and it must never be sent for a dev host).
  if (o.https && !o.isDev) h['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  return h;
}
