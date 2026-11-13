import { describe, expect, it, vi } from 'vitest';
import { verifySignature } from '@/server/domain/email';
import { parseMime } from '@/server/domain/mime';
// @ts-expect-error plain ESM script without types
import worker from '../../scripts/cloudflare-email-worker.mjs';

describe('Cloudflare Email Worker sample (Node, not the Cloudflare runtime)', () => {
  const raw = Buffer.from('From: a@b.co\r\nSubject: hi\r\nMessage-ID: <w1@x>\r\n\r\n안녕');
  it('signs the exact bytes so the server accepts them, and the body parses', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { seen = { url, init }; return new Response('{}', { status: 200 }); });
    await worker.email({ raw: new Response(raw).body }, { CSAI_WEBHOOK_URL: 'https://app.test/api/v1/webhooks/email/abc', CSAI_WEBHOOK_SECRET: 'sek' });
    const h = seen!.init.headers as Record<string, string>; const body = Buffer.from(seen!.init.body as ArrayBuffer);
    expect(h['content-type']).toBe('message/rfc822'); expect(body.equals(raw)).toBe(true);
    expect(verifySignature('sek', h['x-signature-timestamp'], h['x-signature'], body)).toBe(true);
    expect(verifySignature('other', h['x-signature-timestamp'], h['x-signature'], body)).toBe(false);
    expect(parseMime(body).text).toBe('안녕');
  });
  it('throws on a non-2xx webhook answer so the failure is visible', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 401 }));
    await expect(worker.email({ raw: new Response(raw).body }, { CSAI_WEBHOOK_URL: 'https://x', CSAI_WEBHOOK_SECRET: 's' })).rejects.toThrow(/401/);
  });
});
