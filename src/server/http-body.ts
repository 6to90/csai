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
