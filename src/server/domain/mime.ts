// Minimal RFC 5322 / 2045 / 2047 / 2231 parser for inbound mail. Everything in a message is untrusted DATA:
// output is plain text only (HTML is converted, never stored or rendered as HTML), attachments are metadata only.
import { InboundEmail } from './email';

const MAX_DEPTH = 8, MAX_PARTS = 60, MAX_BODY_CHARS = 200_000;
export class MimeError extends Error {}

const ctl = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();   // no CR/LF/NUL/other control chars survive into any stored header-derived field
const dec = (b: Buffer, charset?: string) => { try { return new TextDecoder((charset ?? 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase()).decode(b); } catch { return new TextDecoder('utf-8').decode(b); } };

type Headers = Map<string, string[]>;
function splitHead(buf: Buffer): { head: string; body: Buffer } {
  const s = buf.toString('latin1');
  const m = /\r?\n\r?\n/.exec(s);
  return m ? { head: s.slice(0, m.index), body: buf.subarray(m.index + m[0].length) } : { head: s, body: Buffer.alloc(0) };
}
function parseHeaders(head: string): Headers {
  const h: Headers = new Map();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {      // unfold continuations
    const i = line.indexOf(':'); if (i < 1) continue;
    const k = line.slice(0, i).trim().toLowerCase(); if (!/^[a-z0-9-]+$/.test(k)) continue;
    (h.get(k) ?? h.set(k, []).get(k)!).push(line.slice(i + 1).trim());
  }
  return h;
}
const first = (h: Headers, k: string) => h.get(k)?.[0];

/** RFC 2047 encoded-words (=?charset?B|Q?...?=); raw header bytes are latin1 here, so non-ASCII raw (8-bit) headers are re-read as UTF-8. */
export function decodeWords(v: string): string {
  const raw = /[\u0080-ÿ]/.test(v) ? Buffer.from(v, 'latin1').toString('utf8') : v;
  return ctl(raw.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?)/g, '$1').replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (_m, cs: string, enc: string, txt: string) => {
    const b = enc.toLowerCase() === 'b' ? Buffer.from(txt, 'base64') : qpBytes(txt.replace(/_/g, ' '));
    return dec(b, cs);
  }));
}
function qpBytes(s: string): Buffer {
  const out: number[] = []; const b = Buffer.from(s, 'latin1');
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x3d && i + 2 < b.length + 0 && /^[0-9A-Fa-f]{2}$/.test(b.subarray(i + 1, i + 3).toString('latin1'))) { out.push(parseInt(b.subarray(i + 1, i + 3).toString('latin1'), 16)); i += 2; }
    else if (b[i] === 0x3d && (b[i + 1] === 0x0a || (b[i + 1] === 0x0d && b[i + 2] === 0x0a))) { i += b[i + 1] === 0x0d ? 2 : 1; }   // soft line break
    else out.push(b[i]);
  }
  return Buffer.from(out);
}
function params(v: string): { main: string; p: Record<string, string> } {
  const [main, ...rest] = v.split(';'); const p: Record<string, string> = {};
  for (const part of rest.join(';').match(/[\w*.-]+\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g) ?? []) {
    const i = part.indexOf('='); const k = part.slice(0, i).trim().toLowerCase(); let val = part.slice(i + 1).trim();
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    const ext = /^([^*]+)\*(?:\d+\*?)?$/.exec(k);                                   // RFC 2231: name*=utf-8''%E2...
    if (ext && /^[\w-]*'[\w-]*'/.test(val)) { const [cs, , enc] = [val.split("'")[0], '', val.split("'").slice(2).join("'")]; p[ext[1]] = dec(Buffer.from(decodeURIComponent(enc.replace(/%(?![0-9a-f]{2})/gi, '%25')), 'binary'), cs); }
    else p[k] = val;
  }
  return { main: main.trim().toLowerCase(), p };
}
/** First mailbox of an address header. Returns lowercase address + display name; null when no plausible address. */
export function parseAddress(v: string | undefined): { email: string; name?: string } | null {
  const s = decodeWords(v ?? ''); if (!s) return null;
  const angle = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(s);
  const email = (angle ? angle[2] : /([^\s<>",;()]+@[^\s<>",;()]+)/.exec(s)?.[1])?.toLowerCase();
  if (!email) return null;
  const name = angle ? ctl(angle[1].replace(/^\s*"|"\s*$/g, '').replace(/\\(.)/g, '$1')) : undefined;
  return { email, ...(name ? { name: name.slice(0, 200) } : {}) };
}
const addrList = (vs: string[] | undefined) => (vs ?? []).flatMap((v) => decodeWords(v).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((x) => parseAddress(x)?.email).filter((x): x is string => !!x).slice(0, 50);
const ids = (v: string | undefined) => [...(v ?? '').matchAll(/<([^<>\s]{1,998})>/g)].map((m) => m[1]);

function body(buf: Buffer, enc: string | undefined): Buffer {
  const e = (enc ?? '7bit').trim().toLowerCase();
  if (e === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') return qpBytes(buf.toString('latin1'));
  return buf;
}
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function htmlToText(html: string): string {
  return html.replace(/<(script|style|head|title)[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n').replace(/<[^>]*>?/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => { if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' '; } return ENT[e.toLowerCase()] ?? m; })
    .replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** Attachment names are labels only: strip paths, control and bidi characters, cap the length. */
export const safeFilename = (n: string) => (ctl(n).replace(/[\\/]+/g, '_').replace(/[‪-‮⁦-⁩]/g, '').replace(/^\.+/, '').slice(0, 255)) || 'attachment';

interface Walk { text?: string; html?: string; atts: { filename: string; mime: string; size: number }[]; parts: number }
function walk(buf: Buffer, depth: number, w: Walk, head?: Headers): void {
  if (depth > MAX_DEPTH || ++w.parts > MAX_PARTS) throw new MimeError('too complex');
  let h = head, content = buf;
  if (!h) { const s = splitHead(buf); h = parseHeaders(s.head); content = s.body; }
  const ct = params(first(h, 'content-type') ?? 'text/plain'); const disp = params(first(h, 'content-disposition') ?? '');
  if (ct.main.startsWith('multipart/') && ct.p.boundary) {
    const b = Buffer.from(`--${ct.p.boundary}`); const s = content.toString('latin1'); const segs = s.split(new RegExp(`\\r?\\n?${b.toString('latin1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    for (const seg of segs.slice(1)) { if (seg.length) walk(Buffer.from(seg, 'latin1'), depth + 1, w); }
    return;
  }
  const decoded = body(content, first(h, 'content-transfer-encoding'));
  const fname = disp.p.filename ?? ct.p.name;
  const isAttachment = disp.main === 'attachment' || !!fname || !/^text\/(plain|html)$/.test(ct.main);
  if (isAttachment) { w.atts.push({ filename: safeFilename(decodeWords(fname ?? 'attachment')), mime: ct.main.slice(0, 127) || 'application/octet-stream', size: decoded.length }); return; }
  const t = dec(decoded, ct.p.charset).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (ct.main === 'text/plain') w.text = (w.text ? `${w.text}\n` : '') + t; else w.html = (w.html ? `${w.html}\n` : '') + t;
}

/** Raw RFC 5322 message -> the InboundEmail shape used by the webhook. */
export function parseMime(raw: Buffer): InboundEmail {
  const { head, body: rest } = splitHead(raw); const h = parseHeaders(head);
  const from = parseAddress(first(h, 'from')); if (!from) throw new MimeError('no sender');
  const w: Walk = { atts: [], parts: 0 }; walk(rest, 0, w, h);
  const text = (w.text?.trim() ? w.text : w.html ? htmlToText(w.html) : '').slice(0, MAX_BODY_CHARS);
  const auto = (first(h, 'auto-submitted') ?? 'no').trim().toLowerCase() !== 'no' || /^(bulk|junk|list)$/i.test(first(h, 'precedence')?.trim() ?? '') || h.has('x-auto-response-suppress');
  const date = first(h, 'date') && !Number.isNaN(Date.parse(first(h, 'date')!)) ? new Date(Date.parse(first(h, 'date')!)).toISOString() : undefined;
  return InboundEmail.parse({
    message_id: ids(first(h, 'message-id'))[0], in_reply_to: ids(first(h, 'in-reply-to'))[0], references: ids(h.get('references')?.join(' ')).slice(-50),
    from, to: addrList(h.get('to')), subject: ctl(decodeWords(first(h, 'subject') ?? '')).slice(0, 1000) || undefined, text, date, auto_submitted: auto || undefined,
    attachments: w.atts.slice(0, 20),
  });
}
