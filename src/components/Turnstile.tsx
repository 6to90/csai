'use client';
import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';

// Cloudflare Turnstile (free). Renders nothing when no site key is configured (captcha disabled, e.g. plain local dev).
// 'interaction-only': users only ever see a challenge if Cloudflare is suspicious, so normal sign-in/sign-up UX is unchanged.
declare global { interface Window { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id?: string) => void; remove: (id?: string) => void } } }
export interface TurnstileHandle { reset: () => void }
export const CAPTCHA_ENABLED = !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const Turnstile = forwardRef<TurnstileHandle, { onToken: (t: string | null) => void }>(function Turnstile({ onToken }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  useImperativeHandle(ref, () => ({ reset: () => { onToken(null); window.turnstile?.reset(widget.current); } }), [onToken]);
  useEffect(() => {
    if (!CAPTCHA_ENABLED) return;
    let cancelled = false;
    const mount = () => {
      if (cancelled || !box.current || !window.turnstile) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, appearance: 'interaction-only', theme: 'dark',
        callback: (t: string) => onToken(t), 'expired-callback': () => onToken(null), 'error-callback': () => onToken(null),
      });
    };
    if (window.turnstile) mount();
    else {
      const s = document.createElement('script'); s.src = SRC; s.async = true; s.onload = mount;   // allowed by CSP via 'strict-dynamic' (inserted by our nonced bundle)
      document.head.appendChild(s);
    }
    return () => { cancelled = true; if (widget.current) window.turnstile?.remove(widget.current); };
  }, [onToken]);
  return CAPTCHA_ENABLED ? <div ref={box} aria-label="보안 확인" /> : null;
});
