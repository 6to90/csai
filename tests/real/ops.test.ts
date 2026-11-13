import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { call, mkUser, mkOrg, uniq } from '../api/helpers';

// Operational behaviour of a SECOND Next server (port 3113) sharing the same database: stream capacity, first-byte latency, SIGTERM drain.
const ORIGIN = 'https://shop.example', PORT = 3113, BASE2 = `http://127.0.0.1:${PORT}`;
const rip = () => ({ 'x-forwarded-for': `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
async function boot(env: Record<string, string> = {}) {
  const child: ChildProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], { env: { ...process.env, ...env }, stdio: 'ignore' });
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  for (let i = 0; i < 60; i++) { if (await fetch(`${BASE2}/api/v1/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 500)); }
  return { child, exited };
}
async function session() {
  const owner = await mkUser('op'); const org = await mkOrg(owner);
  const ch = await call('POST', '/api/v1/channels', { user: owner, org, body: { kind: 'web_chat', name: 'W', allowed_origins: [ORIGIN] } });
  const r = await fetch(`${BASE2}/api/v1/chat/sessions`, { method: 'POST', headers: { ...rip(), origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ public_key: ch.body.data.public_key, visitor_id: `vis-${uniq()}${uniq()}` }) });
  return (await r.json()).data.token as string;
}
const open = (tok: string, ms = 30) => fetch(`${BASE2}/api/v1/chat/stream?max_s=${ms}`, { headers: { ...rip(), origin: ORIGIN, authorization: `Bearer ${tok}` } });

describe('second server: capacity, first bytes, graceful SIGTERM', () => {
  it('first bytes (padding + ready) arrive immediately; the cap answers 503 + Retry-After while polling keeps working; SIGTERM drains within seconds without telling the widget the chat ended', async () => {
    const srv = await boot({ STREAM_MAX_CONNECTIONS: '1' });
    try {
      const tok = await session(); const tok2 = await session();
      const t0 = Date.now(); const a = await open(tok); expect(a.status).toBe(200);
      const reader = a.body!.getReader(); const first = await reader.read(); const ttfb = Date.now() - t0;
      const text = new TextDecoder().decode(first.value); expect(ttfb).toBeLessThan(2000);
      expect(text).toContain('retry: 2000'); expect(first.value!.length).toBeGreaterThan(2048); expect(text).toContain('event: ready');   // a buffering proxy sees >2 KB right away
      const b = await open(tok2); expect([b.status, b.headers.get('retry-after')]).toEqual([503, '5']);
      const poll = await fetch(`${BASE2}/api/v1/chat/messages`, { headers: { ...rip(), origin: ORIGIN, authorization: `Bearer ${tok2}` } }); expect(poll.status).toBe(200);   // fallback path is unaffected by the cap

      // SIGTERM with the stream open (it could otherwise live 30 s)
      const t1 = Date.now(); srv.child.kill('SIGTERM');
      let rest = ''; const dec = new TextDecoder();
      for (;;) { const c = await reader.read(); if (c.done) break; rest += dec.decode(c.value); }
      const drained = Date.now() - t1; expect(drained).toBeLessThan(5000);
      expect(rest).not.toContain('event: closed');                                         // not "chat ended": the widget just reconnects elsewhere
      const code = await Promise.race([srv.exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 8000))]);
      expect(code).not.toBe('timeout');
      expect((await fetch(`${BASE2}/api/v1/health`).catch(() => null))?.ok ?? false).toBe(false);   // the instance is gone
      // the session itself is untouched: the same token still works on the other instance
      const main = await fetch(`${process.env.API_BASE}/api/v1/chat/messages`, { headers: { ...rip(), origin: ORIGIN, authorization: `Bearer ${tok}` } }); expect(main.status).toBe(200);
    } finally { srv.child.kill('SIGKILL'); }
  }, 90_000);
  it('a server that is shutting down refuses new streams (503) so widgets move to the live instance', async () => {
    const srv = await boot();
    try {
      const tok = await session(); const hold = await open(tok); const r = hold.body!.getReader(); await r.read();
      srv.child.kill('SIGTERM'); await new Promise((x) => setTimeout(x, 400));
      const again = await open(await session().catch(() => tok)).catch(() => null);
      expect(again === null || again.status === 503).toBe(true);                          // refused or already closed: never accepted for a long stream
      await r.cancel().catch(() => undefined);
    } finally { srv.child.kill('SIGKILL'); }
  }, 60_000);
});
