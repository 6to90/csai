import { redact } from './security/mask';
export function log(level: 'info' | 'warn' | 'error', msg: string, ctx: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ level, msg, ...(redact(ctx) as object), ts: new Date().toISOString() }));
}
