import 'server-only';
import { HttpError } from './http';

/**
 * Reads a request body with a hard byte cap, enforced on the bytes actually received (never on the Content-Length header alone: it can be
 * absent (chunked), wrong, or lie). Reading stops and the stream is cancelled the moment the cap is exceeded, so an oversized upload
 * is never buffered whole. A malformed Content-Length is rejected; a well-formed one that already exceeds the cap is rejected without reading.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<Buffer> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) throw new HttpError(400, 'bad_request', 'invalid content-length');
    if (Number(declared) > maxBytes) throw new HttpError(413, 'payload_too_large');
  }
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'payload_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks, total);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** Per-endpoint caps (bytes), sized from each schema's largest legitimate body incl. UTF-8 and JSON escaping. */
export const JSON_LIMIT = { token: 2 * 1024, tiny: 4 * 1024, small: 8 * 1024, form: 16 * 1024, chatMessage: 64 * 1024, agentMessage: 128 * 1024 } as const;

/**
 * Streaming JSON body reader for every route. Same contract as the old `req.json().catch(() => null)`: empty or malformed JSON (and invalid UTF-8)
 * yields `null`, which the caller's schema rejects with 422. The ONLY new behaviour is the size cap: more than `maxBytes` actually received => 413
 * (reading stops immediately); a malformed Content-Length => 400. The cap is enforced on received bytes, never on the header.
 */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const raw = await readBodyCapped(req, maxBytes);
  if (raw.length === 0) return null;
  try { return JSON.parse(utf8.decode(raw)); } catch { return null; }
}
