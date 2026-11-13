import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { smtpSender } from '@/server/adapters/mail';

// A scripted SMTP server: checks the dialogue, dot-stuffing and header-injection stripping of the minimal client.
describe('smtpSender (plain)', () => {
  it('speaks EHLO/MAIL/RCPT/DATA, base64 body, and strips CR/LF from headers', async () => {
    const seen: string[] = []; let data = '';
    const srv = createServer((s) => {
      let inData = false, buf = '';
      s.on('error', () => undefined); s.write('220 test\r\n');
      s.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\r\n')) >= 0 || (inData && buf.includes('\r\n.\r\n'))) {
        if (inData) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) break; data = buf.slice(0, e); buf = ''; inData = false; s.write('250 queued\r\n'); break; }
        const line = buf.slice(0, i); buf = buf.slice(i + 2); seen.push(line);
        if (line.startsWith('EHLO')) s.write('250-test\r\n250 8BITMIME\r\n'); else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') s.end('221 bye\r\n'); else s.write('250 ok\r\n');
      } });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    process.env.MAIL_FROM = 'noreply@csai.test';
    await smtpSender(`smtp://127.0.0.1:${(srv.address() as { port: number }).port}`).send({ to: 'a@example.com\r\nRCPT TO:<evil@x.com>', subject: 's\r\nBcc: e@x.com', text: '.hidden\nline2' });
    srv.close();
    expect(seen.filter((l) => l.startsWith('RCPT'))).toEqual(['RCPT TO:<a@example.com RCPT TO:<evil@x.com>>']);   // injected newline flattened, still one RCPT
    expect(data).toContain('Subject: =?UTF-8?B?'); expect(data).not.toMatch(/^Bcc:/m);
    expect(Buffer.from(data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString()).toBe('..hidden\r\nline2');
  });
});
