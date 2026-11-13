import { describe, expect, it } from 'vitest';
import { decodeWords, htmlToText, parseAddress, parseMime, safeFilename } from '@/server/domain/mime';
import { toInboundMessage } from '@/server/domain/email';

const msg = (s: string) => Buffer.from(s.replace(/\n/g, '\r\n'), 'latin1');
const H = `From: "Kim, Customer" <Kim@Example.COM>\nTo: Support <support@acme.test>, other@acme.test\nSubject: =?UTF-8?B?7KO866y4IOusuOydmA==?=\nMessage-ID: <ABC.1@Mail.Example>\nDate: Wed, 12 Nov 2026 10:00:00 +0900\n`;

describe('headers', () => {
  it('extracts sender, recipients, decoded subject, ids and date', () => {
    const m = parseMime(msg(`${H}In-Reply-To: <p1@x>\nReferences: <r0@x>\n <p1@x>\nContent-Type: text/plain; charset=utf-8\n\nhello`));
    expect(m).toMatchObject({ from: { email: 'kim@example.com', name: 'Kim, Customer' }, to: ['support@acme.test', 'other@acme.test'], subject: '주문 문의', message_id: 'ABC.1@Mail.Example', in_reply_to: 'p1@x', references: ['r0@x', 'p1@x'], text: 'hello', date: '2026-11-12T01:00:00.000Z' });
    expect(toInboundMessage(m)).toMatchObject({ external_id: 'abc.1@mail.example', references: ['r0@x', 'p1@x'] });
  });
  it('decodes Q-encoded words in other charsets and joins adjacent words', () => {
    expect(decodeWords('=?ISO-8859-1?Q?caf=E9_au?= =?UTF-8?Q?_lait?=')).toBe('café au lait');
    expect(decodeWords('=?euc-kr?B?yNg=?=')).toBeTruthy();
  });
  it('header injection: CR/LF/NUL inside encoded words or addresses never reach stored fields', () => {
    const evil = Buffer.from('X\r\nBcc: evil@x.com\0Y').toString('base64');
    const m = parseMime(msg(`From: "A =?UTF-8?B?${evil}?=" <a@b.co>\nSubject: =?UTF-8?B?${evil}?=\n\nx`));
    for (const v of [m.subject, m.from.name]) expect(v).not.toMatch(/[\r\n\0]/);
    expect(parseAddress('no address here')).toBeNull();
    expect(() => parseMime(msg('Subject: x\n\nbody'))).toThrow(/no sender/);
  });
  it('flags automatic mail (Auto-Submitted, Precedence: bulk)', () => {
    expect(parseMime(msg(`${H}Auto-Submitted: auto-replied\n\nx`)).auto_submitted).toBe(true);
    expect(parseMime(msg(`${H}Precedence: bulk\n\nx`)).auto_submitted).toBe(true);
    expect(parseMime(msg(`${H}Auto-Submitted: no\n\nx`)).auto_submitted).toBeUndefined();
  });
});

describe('bodies', () => {
  it('multipart/alternative prefers text/plain; quoted-printable and base64 are decoded in the declared charset', () => {
    const m = parseMime(msg(`${H}Content-Type: multipart/alternative; boundary="B1"\n\n--B1\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nCaf=C3=A9 =\nline\n--B1\nContent-Type: text/html; charset=utf-8\n\n<b>HTML</b>\n--B1--\n`));
    expect(m.text).toBe('Café line');
    const b = parseMime(msg(`${H}Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${Buffer.from('안녕하세요').toString('base64')}`));
    expect(b.text).toBe('안녕하세요');
    const k = parseMime(Buffer.concat([msg(`${H}Content-Type: text/plain; charset=euc-kr\nContent-Transfer-Encoding: 8bit\n\n`), Buffer.from([0xbe, 0xc8, 0xb3, 0xe7])]));
    expect(k.text).toBe('안녕');
  });
  it('HTML-only mail becomes plain text: scripts, styles, tags and event handlers are gone, entities decoded', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><p onclick="x()">Hi &amp; welcome<br>line2</p><img src=x onerror=alert(2)><a href="javascript:alert(3)">link</a>&lt;b&gt; &#65;</body></html>';
    const m = parseMime(msg(`${H}Content-Type: text/html; charset=utf-8\n\n${html}`));
    expect(m.text).toBe('Hi & welcome\nline2\nlink <b> A');
    expect(m.text).not.toMatch(/alert|onerror|onclick|<script|javascript:/i);
    expect(htmlToText('<scr<script>ipt>alert(1)</script>')).not.toContain('<script');
  });
  it('nested multipart/mixed: attachments are metadata only (size from decoded bytes, sanitised names, never trusted types)', () => {
    const file = Buffer.from('MZ\x90fake-exe').toString('base64');
    const m = parseMime(msg(`${H}Content-Type: multipart/mixed; boundary=OUT\n\n--OUT\nContent-Type: multipart/alternative; boundary=IN\n\n--IN\nContent-Type: text/plain\n\nbody text\n--IN--\n--OUT\nContent-Type: application/x-msdownload; name="..\\..\\evil‮gpj.exe"\nContent-Disposition: attachment; filename*=UTF-8''%E2%80%AEr%C3%A9sum%C3%A9.pdf\nContent-Transfer-Encoding: base64\n\n${file}\n--OUT--\n`));
    expect(m.text).toBe('body text'); expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0]).toMatchObject({ mime: 'application/x-msdownload', size: Buffer.from(file, 'base64').length });
    expect(m.attachments![0].filename).not.toMatch(/[\\/‪-‮]/);
    expect(safeFilename('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/^\.+/, ''));
    expect(safeFilename('\r\n')).toBe('attachment');
  });
  it('limits: deeply nested or huge multipart is rejected, body capped', () => {
    let s = ''; for (let i = 0; i < 12; i++) s += `Content-Type: multipart/mixed; boundary=b${i}\n\n--b${i}\n`;
    expect(() => parseMime(msg(`${H}${s}x`))).toThrow(/too complex/);
    const big = parseMime(msg(`${H}Content-Type: text/plain\n\n${'a'.repeat(300_000)}`)); expect(big.text.length).toBe(200_000);
    expect(() => parseMime(msg(`${H}Content-Type: multipart/mixed; boundary=z\n\n${'--z\n\nx\n'.repeat(80)}`))).toThrow(/too complex/);
  });
  it('LF-only and missing headers do not crash', () => {
    expect(parseMime(Buffer.from('From: a@b.co\n\nplain')).text).toBe('plain');
    expect(parseMime(Buffer.from('From: a@b.co')).text).toBe('');
  });
});
