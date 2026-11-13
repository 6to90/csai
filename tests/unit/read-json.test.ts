import { describe, expect, it } from 'vitest';
import { JSON_LIMIT, readJson } from '@/server/http-body';
import { HttpError } from '@/server/http';

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request('http://x/api', { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return (e as HttpError).status; } };
const bytes = (s: string) => new TextEncoder().encode(s);

describe('readJson (same contract as req.json().catch(() => null), plus a streamed size cap)', () => {
  it('parses valid JSON, including multi-byte text', async () => {
    expect(await readJson(post(JSON.stringify({ body: '안녕하세요 👋', n: 1 })), 1024)).toEqual({ body: '안녕하세요 👋', n: 1 });
  });
  it.each(['', '   ', '{', '{"a":', 'not json', '[1,2', "{'a':1}", '\u0000'])('invalid or empty body %j => null (caller answers 422), never a throw', async (b) => {
    expect(await readJson(post(b), 1024)).toBeNull();
  });
  it('missing body => null', async () => { expect(await readJson(post(null), 1024)).toBeNull(); });
  it('invalid UTF-8 => null', async () => { expect(await readJson(post(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])), 1024)).toBeNull(); });
  it('JSON that is valid but not an object still comes back as-is (schema decides)', async () => { expect(await readJson(post('"x"'), 1024)).toBe('x'); expect(await readJson(post('null'), 1024)).toBeNull(); });
  it('over the cap => 413; exactly at the cap passes', async () => {
    const ok = JSON.stringify({ a: 'x'.repeat(100) }); const n = bytes(ok).length;
    expect(await readJson(post(ok), n)).toBeTruthy();
    expect(await status(readJson(post(ok), n - 1))).toBe(413);
  });
  it('chunked upload that never ends is cut off: 413, stream cancelled, bounded reads', async () => {
    let pulls = 0, cancelled = false;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(bytes('{"a":"' + 'x'.repeat(1000))); }, cancel() { cancelled = true; } });
    expect(await status(readJson(post(endless), 4096))).toBe(413);
    expect(cancelled).toBe(true); expect(pulls).toBeLessThan(20);
  });
  it('a body split across many small chunks is reassembled correctly', async () => {
    const full = bytes(JSON.stringify({ k: '한국어'.repeat(20) })); let i = 0;
    const s = new ReadableStream<Uint8Array>({ pull(c) { if (i >= full.length) return c.close(); c.enqueue(full.slice(i, i + 3)); i += 3; } });   // splits multi-byte characters
    expect(await readJson(post(s), 4096)).toEqual({ k: '한국어'.repeat(20) });
  });
  it('lying small Content-Length cannot smuggle a large body; malformed Content-Length => 400', async () => {
    const big = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(2048)); } });
    expect(await status(readJson(post(big, { 'content-length': '3' }), 4096))).toBe(413);
    for (const v of ['abc', '-1', '1.5']) expect(await status(readJson(post('{}', { 'content-length': v }), 4096))).toBe(400);
  });
  it('declared oversize Content-Length => 413 without reading', async () => {
    expect(await status(readJson(post('{}', { 'content-length': '999999' }), 4096))).toBe(413);
  });
  it('limits are sane: every cap is positive and ordered', () => {
    const v = Object.values(JSON_LIMIT); expect(v.every((n) => n > 0)).toBe(true); expect(JSON_LIMIT.token).toBeLessThan(JSON_LIMIT.chatMessage);
  });
});
