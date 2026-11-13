import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket, createServer as tlsServer } from 'node:tls';
import { beforeAll, describe, expect, it } from 'vitest';
import { SmtpError, smtpSender } from '@/server/adapters/mail';

// Real TLS/AUTH conversations against an in-process SMTP server using openssl-generated certificates.
let good: { key: string; cert: string }, bad: { key: string; cert: string };
function mkCert(dir: string, name: string, san: string) {
  writeFileSync(join(dir, `${name}.cnf`), `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${name}\n[v3]\nsubjectAltName=${san}\n`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`), '-days', '2', '-config', join(dir, `${name}.cnf`)], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, `${name}.key`), 'utf8'), cert: readFileSync(join(dir, `${name}.crt`), 'utf8') };
}
beforeAll(() => { const d = mkdtempSync(join(tmpdir(), 'smtp-')); good = mkCert(d, 'good', 'DNS:localhost,IP:127.0.0.1'); bad = mkCert(d, 'bad', 'DNS:other.example'); });

interface Opt { mode: 'plain' | 'implicit' | 'starttls'; cert?: { key: string; cert: string }; creds?: [string, string]; offerStarttls?: boolean; mechs?: string; rcpt?: string; dataReply?: string; drop?: boolean }
async function server(o: Opt) {
  const seen: { cmd: string; tls: boolean }[] = []; const data: string[] = [];
  const serve = (s: Socket, isTls: boolean) => {
    let buf = '', inData = false; s.on('error', () => undefined);
    const onData = (d: Buffer) => { buf += d.toString(); for (;;) {
      if (inData) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) return; data.push(buf.slice(0, e)); buf = ''; inData = false; if (o.drop) { s.destroy(); return; } s.write(`${o.dataReply ?? '250 2.0.0 Ok: queued as Q123'}\r\n`); continue; }
      const i = buf.indexOf('\r\n'); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2); seen.push({ cmd: line.startsWith('AUTH') ? line.split(' ')[0] : line, tls: isTls });
      if (line.startsWith('EHLO')) s.write(`250-localhost\r\n${o.mode === 'starttls' && !isTls && o.offerStarttls !== false ? '250-STARTTLS\r\n' : ''}${o.creds ? `250-AUTH ${o.mechs ?? 'PLAIN LOGIN'}\r\n` : ''}250 8BITMIME\r\n`);
      else if (line === 'STARTTLS') { s.write('220 go\r\n'); s.removeAllListeners('data'); serve(new TLSSocket(s, { isServer: true, key: o.cert!.key, cert: o.cert!.cert }), true); return; }
      else if (line.startsWith('AUTH PLAIN')) { const [, u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0'); s.write(u === o.creds![0] && p === o.creds![1] ? '235 ok\r\n' : '535 5.7.8 bad credentials\r\n'); }
      else if (line === 'AUTH LOGIN') { s.write('334 VXNlcm5hbWU6\r\n'); let step = 0; let u = ''; const h = (dd: Buffer) => { const v = Buffer.from(dd.toString().trim(), 'base64').toString(); if (step === 0) { u = v; step = 1; s.write('334 UGFzc3dvcmQ6\r\n'); } else { s.removeListener('data', h); s.on('data', onData); s.write(u === o.creds![0] && v === o.creds![1] ? '235 ok\r\n' : '535 bad\r\n'); } }; s.removeListener('data', onData); s.on('data', h); }
      else if (line.startsWith('RCPT')) s.write(`${o.rcpt ?? '250'} rcpt\r\n`);
      else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') s.end('221 bye\r\n'); else s.write('250 ok\r\n');
    } };
    s.on('data', onData);
  };
  const srv: Server = o.mode === 'implicit' ? (tlsServer({ key: o.cert!.key, cert: o.cert!.cert }, (s) => { s.write('220 t\r\n'); serve(s, true); }) as unknown as Server) : createServer((s) => { s.write('220 t\r\n'); serve(s, false); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: (srv.address() as { port: number }).port, seen, data };
}
const msg = { to: 'buyer@example.com', from: 'support@acme.test', subject: '문의 답변', text: 'hello\n.dot', messageId: 'id1@csai.local' };
const attempt = async (o: Opt, url: (p: number) => string, ca?: string) => { const s = await server(o); try { return { s, out: await smtpSender(url(s.port), { ca, timeoutMs: 3000 }).send(msg).then((r) => r, (e) => e as SmtpError) }; } finally { s.srv.close(); } };

describe('TLS', () => {
  it('implicit TLS + AUTH PLAIN succeed with a trusted CA; credentials only travel inside TLS; the server verdict is returned as ref', async () => {
    const { s, out } = await attempt({ mode: 'implicit', cert: good, creds: ['u', 'p w'] }, (p) => `smtps://u:p%20w@127.0.0.1:${p}`, good.cert);
    expect(out).toEqual({ ref: '2.0.0 Ok: queued as Q123' }); expect(s.seen.find((x) => x.cmd === 'AUTH')?.tls).toBe(true);
    expect(s.data[0]).toContain('Message-ID: <id1@csai.local>'); expect(s.data[0]).toMatch(/^From: support@acme.test\r\nTo: buyer@example.com\r\nDate: /);
  });
  it('an untrusted (self-signed) certificate is refused and nothing is sent', async () => {
    const { s, out } = await attempt({ mode: 'implicit', cert: good, creds: ['u', 'p'] }, (p) => `smtps://u:p@127.0.0.1:${p}`);
    expect(out).toMatchObject({ code: 'tls_cert_invalid', kind: 'permanent' }); expect(s.seen).toEqual([]);
  });
  it('a certificate for a different host is refused even if its CA is trusted', async () => {
    const { out } = await attempt({ mode: 'implicit', cert: bad, creds: ['u', 'p'] }, (p) => `smtps://u:p@127.0.0.1:${p}`, bad.cert);
    expect(out).toMatchObject({ code: 'tls_cert_invalid', kind: 'permanent' });
  });
  it('STARTTLS + AUTH LOGIN succeed; AUTH is sent only after the upgrade', async () => {
    const { s, out } = await attempt({ mode: 'starttls', cert: good, creds: ['u', 'p'], mechs: 'LOGIN' }, (p) => `smtp+starttls://u:p@127.0.0.1:${p}`, good.cert);
    expect(out).toMatchObject({ ref: expect.any(String) }); expect(s.seen.filter((x) => x.cmd === 'AUTH').every((x) => x.tls)).toBe(true); expect(s.seen.some((x) => x.cmd === 'STARTTLS')).toBe(true);
  });
  it('STARTTLS not offered => refuses (no plaintext downgrade): no AUTH, MAIL or DATA was ever sent', async () => {
    const { s, out } = await attempt({ mode: 'starttls', cert: good, creds: ['u', 'p'], offerStarttls: false }, (p) => `smtp+starttls://u:p@127.0.0.1:${p}`, good.cert);
    expect(out).toMatchObject({ code: 'starttls_unsupported', kind: 'permanent' }); expect(s.seen.map((x) => x.cmd)).toEqual(['EHLO csai']); expect(s.data).toEqual([]);
  });
  it('credentials on a plain smtp:// URL are refused locally', async () => {
    const { s, out } = await attempt({ mode: 'plain', creds: ['u', 'p'] }, (p) => `smtp://u:p@127.0.0.1:${p}`);
    expect(out).toMatchObject({ code: 'auth_requires_tls', kind: 'permanent' }); expect(s.seen.some((x) => x.cmd === 'AUTH')).toBe(false);
  });
});

describe('AUTH and result classification', () => {
  const tlsUrl = (p: number) => `smtps://u:wrong@127.0.0.1:${p}`;
  it('bad credentials => permanent auth_failed (retrying cannot help)', async () => {
    expect((await attempt({ mode: 'implicit', cert: good, creds: ['u', 'p'] }, tlsUrl, good.cert)).out).toMatchObject({ code: 'auth_failed', kind: 'permanent' });
    expect((await attempt({ mode: 'implicit', cert: good, creds: ['u', 'p'], mechs: 'LOGIN' }, tlsUrl, good.cert)).out).toMatchObject({ code: 'auth_failed', kind: 'permanent' });
  });
  it('unsupported mechanisms are reported', async () => {
    expect((await attempt({ mode: 'implicit', cert: good, creds: ['u', 'p'], mechs: 'XOAUTH2' }, (p) => `smtps://u:p@127.0.0.1:${p}`, good.cert)).out).toMatchObject({ code: 'auth_unsupported', kind: 'permanent' });
  });
  it('4xx => transient, 5xx => permanent (per stage)', async () => {
    expect((await attempt({ mode: 'plain', rcpt: '451' }, (p) => `smtp://127.0.0.1:${p}`)).out).toMatchObject({ code: 'smtp_451', kind: 'transient' });
    expect((await attempt({ mode: 'plain', rcpt: '550' }, (p) => `smtp://127.0.0.1:${p}`)).out).toMatchObject({ code: 'smtp_550', kind: 'permanent' });
    expect((await attempt({ mode: 'plain', dataReply: '554 5.7.1 rejected as spam' }, (p) => `smtp://127.0.0.1:${p}`)).out).toMatchObject({ code: 'smtp_554', kind: 'permanent' });
    expect((await attempt({ mode: 'plain', dataReply: '452 4.3.1 insufficient storage' }, (p) => `smtp://127.0.0.1:${p}`)).out).toMatchObject({ code: 'smtp_452', kind: 'transient' });
  });
  it('connection lost AFTER the body was sent => uncertain_delivery (never a blind retry); lost BEFORE => transient', async () => {
    expect((await attempt({ mode: 'plain', drop: true }, (p) => `smtp://127.0.0.1:${p}`)).out).toMatchObject({ code: 'uncertain_delivery', kind: 'uncertain' });
    const s = await server({ mode: 'plain' }); const port = s.port; s.srv.close(); await new Promise((r) => setTimeout(r, 50));
    expect(await smtpSender(`smtp://127.0.0.1:${port}`, { timeoutMs: 1000 }).send(msg).catch((e) => e)).toMatchObject({ code: 'connect_refused', kind: 'transient' });
  });
  it('display name is RFC 2047-encoded and header-injection attempts cannot add headers or recipients', async () => {
    const s = await server({ mode: 'plain' });
    await smtpSender(`smtp://127.0.0.1:${s.port}`).send({ ...msg, fromName: 'Acme 지원\r\nBcc: x@evil.test', to: 'buyer@example.com\r\nRCPT TO:<x@evil.test>', subject: 's\r\nBcc: x@evil.test', inReplyTo: 'p@x>\r\nBcc: y@evil.test' }); s.srv.close();
    expect(s.seen.filter((x) => x.cmd.startsWith('RCPT'))).toHaveLength(1);
    expect(s.data[0]).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <support@acme.test>/); expect(s.data[0]).not.toMatch(/^Bcc:/m);
  });
});
