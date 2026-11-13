import { describe, expect, it } from 'vitest';
import { readBodyCapped } from '@/server/http-body';
import { HttpError } from '@/server/http';

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request('http://x/hook', { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
const stream = (chunks: Uint8Array[], onPull?: () => void) => { let i = 0; return new ReadableStream<Uint8Array>({ pull(c) { onPull?.(); if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); } }); };
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return (e as HttpError).status; } };

describe('readBodyCapped', () => {
  it('reads a body within the cap exactly', async () => {
    expect((await readBodyCapped(post('hello'), 10)).toString()).toBe('hello');
  });
  it('empty / missing body => empty buffer (caller then fails signature or parsing)', async () => {
    expect((await readBodyCapped(post(null), 10)).length).toBe(0);
    expect((await readBodyCapped(post(''), 10)).length).toBe(0);
  });
  it('declared Content-Length over the cap => 413 without reading anything', async () => {
    let pulled = 0; const req = post(stream([new Uint8Array(5)], () => pulled++), { 'content-length': '99999999' });
    await new Promise((r) => setTimeout(r, 5));                         // let the Request constructor finish priming the stream
    const before = pulled;
    expect(await status(readBodyCapped(req, 10))).toBe(413);
    expect(pulled).toBe(before);
  });
  it.each(['abc', '-1', '1e9', '12 34', '1.5', '0x10', '99999999999999999999'])('malformed Content-Length %j => 400', async (v) => {
    expect(await status(readBodyCapped(post('x', { 'content-length': v }), 10))).toBe(400);
  });
  it('chunked upload (no Content-Length) over the cap => 413 and the stream is cancelled early, not read to the end', async () => {
    let pulls = 0, cancelled = false;
    const big = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });   // endless
    expect(await status(readBodyCapped(post(big), 4096))).toBe(413);
    expect(cancelled).toBe(true); expect(pulls).toBeLessThan(20);
  });
  it('a LYING small Content-Length cannot smuggle an oversized body past the cap', async () => {
    const r = post(stream([new Uint8Array(3000), new Uint8Array(3000)]), { 'content-length': '5' });
    expect(await status(readBodyCapped(r, 4000))).toBe(413);
  });
  it('exactly at the cap is accepted, one byte more is rejected', async () => {
    expect((await readBodyCapped(post(stream([new Uint8Array(4), new Uint8Array(4)])), 8)).length).toBe(8);
    expect(await status(readBodyCapped(post(stream([new Uint8Array(4), new Uint8Array(5)])), 8))).toBe(413);
  });
});
