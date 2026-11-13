import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import './globals.css';
export const metadata = { title: 'AI Customer Operations' };
// Reading headers() makes every page dynamic, which is required for per-request CSP nonces (static pages cannot carry one).
export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (<html lang="ko"><body>{children}</body></html>);
}
