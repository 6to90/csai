import { createHmac } from 'node:crypto';

// RFC 6238 TOTP (SHA-1, 30s, 6 digits) for driving real GoTrue MFA from tests.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Decode(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
