import { preflight, requireChatSession, withCors } from '@/server/chat';
import { HttpError, route } from '@/server/http';
import { enforceRateLimit } from '@/server/security/ratelimit';
import { shutdownState } from '@/server/shutdown';
import { systemClient } from '@/server/security/system-client';

export const OPTIONS = preflight;
export const dynamic = 'force-dynamic';
const TICK_MS = 1500, BEAT_MS = 15_000;
let active = 0;                                                    // open streams in THIS instance
const PAD = `: ${' '.repeat(2048)}\n\n`;                            // pushes the first bytes through proxies that buffer small responses

// Server-Sent Events. Auth = the same opaque bearer token (so the client reads the stream with fetch, EventSource cannot send headers).
// Each connection lives at most `max_s` (<=55s, serverless-friendly); the client reconnects with Last-Event-ID / ?after. Delivery is idempotent by message id.
export const GET = withCors(route(async (req) => {
  const s = await requireChatSession(req);
  await enforceRateLimit(`chat:${s.id}:stream`, 30, 60, { failClosed: true });
  // Each stream polls the DB every tick: cap concurrency per instance. Over the cap the widget gets 503 and falls back to cheap polling.
  if (active >= (Number(process.env.STREAM_MAX_CONNECTIONS) || 200) || shutdownState.down) throw new HttpError(503, 'unavailable', 'stream capacity reached', { 'retry-after': '5' });
  const url = new URL(req.url);
  const maxMs = Math.min(Math.max(Number(url.searchParams.get('max_s')) || 55, 1), 55) * 1000;
  let cursor = req.headers.get('last-event-id') || url.searchParams.get('after') || '';
  if (cursor && Number.isNaN(Date.parse(cursor))) cursor = '';
  const db = systemClient(); const enc = new TextEncoder(); const started = Date.now();
  const sent = new Set<string>();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const send = (chunk: string) => { try { ctrl.enqueue(enc.encode(chunk)); } catch { /* client went away */ } };
      active++;
      send(`retry: 2000\n\n${PAD}event: ready\ndata: {}\n\n`);          // first bytes at once: lets the client prove the stream is not being buffered
      let lastBeat = Date.now(), lastSeen = Date.now();
      try {
        while (!req.signal.aborted && !shutdownState.down && Date.now() - started < maxMs) {
          let q = db.from('messages').select('id,direction,body,created_at').eq('org_id', s.org_id).eq('conversation_id', s.conversation_id)
            .or('direction.eq.inbound,and(direction.eq.outbound,status.eq.sent,sender_type.in.(agent,ai,system))').order('created_at').limit(100);
          if (cursor) q = q.gte('created_at', cursor);
          const { data } = await q;
          for (const m of data ?? []) { if (sent.has(m.id)) continue; sent.add(m.id); cursor = m.created_at; send(`id: ${m.created_at}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`); }
          const { data: sess } = await db.from('chat_sessions').select('revoked_at,expires_at').eq('id', s.id).eq('org_id', s.org_id).maybeSingle();
          if (!sess || sess.revoked_at || new Date(sess.expires_at).getTime() <= Date.now()) { send('event: closed\ndata: {}\n\n'); break; }   // ended by an agent / expired: tell the widget, then stop
          if (Date.now() - lastSeen > BEAT_MS) { lastSeen = Date.now(); await db.from('chat_sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', s.id).eq('org_id', s.org_id); }   // presence + keeps the idle timer alive
          if (Date.now() - lastBeat > BEAT_MS) { lastBeat = Date.now(); send(': ping\n\n'); }
          for (let w = 0; w < TICK_MS && !shutdownState.down && !req.signal.aborted; w += 250) await new Promise((r) => setTimeout(r, 250));   // short slices: SIGTERM ends the stream within 250 ms
        }
      } finally { active--; try { ctrl.close(); } catch { /* already closed */ } }
    },
  });
  if (!stream) throw new HttpError(500, 'internal');
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}));
