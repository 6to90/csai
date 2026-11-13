import 'server-only';
import { connect as tcp, isIP, type Socket } from 'node:net';
import { connect as tls } from 'node:tls';
import { allowPrivateSmtp, guardedLookup, isBlockedAddress, SmtpTargetError } from '@/server/security/net-guard';

/** Outbound mail boundary (CLAUDE.md §3.6). Domain code only sees MailSender. Configure with MAIL_TRANSPORT = mailpit | smtp; unset => none (callers fall back to returning the link once). */
export interface MailMessage { to: string; subject: string; text: string; from?: string; fromName?: string; messageId?: string; inReplyTo?: string; references?: string[] }
export interface MailSender { send(m: MailMessage): Promise<MailResult | void> }

const FROM = () => process.env.MAIL_FROM ?? 'no-reply@localhost';
const clean = (s: string) => s.replace(/[\r\n]+/g, ' ');          // header-injection guard

/** Dev: Mailpit's HTTP send API (the local Supabase stack's mailbox). */
export const mailpitSender = (baseUrl: string): MailSender => ({
  async send(m) {
    const r = await fetch(`${baseUrl}/api/v1/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ From: { Email: FROM() }, To: [{ Email: m.to }], Subject: clean(m.subject), Text: m.text }) });
    if (!r.ok) throw new Error(`mailpit ${r.status}`);
  },
});

/**
 * Classified SMTP failure. `transient` = retry later (4xx, network); `permanent` = retrying cannot help until config/recipient changes (5xx, bad TLS cert, auth);
 * `uncertain` = the connection died AFTER the message body was sent but before the server's verdict: it may or may not have been delivered.
 */
export class SmtpError extends Error {
  constructor(msg: string, public code: string, public kind: 'transient' | 'permanent' | 'uncertain') { super(msg); }
}
export interface MailResult { ref?: string }
/** publicOnly: tenant-supplied host. Refuses loopback/private/reserved targets, including after DNS resolution at connect time (anti-rebinding). */
export interface SmtpOptions { ca?: string | Buffer; timeoutMs?: number; publicOnly?: boolean }
const CERT_ERR = /^(ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT.*|CERT_.*|ERR_SSL_.*)$/;
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, '');

/**
 * SMTP client (RFC 5321/3207/4954). URL: smtp://host:25 (plain; no credentials allowed) | smtps://[user:pass@]host:465 (implicit TLS) | smtp+starttls://[user:pass@]host:587.
 * TLS certificates and hostnames are ALWAYS verified. STARTTLS is never silently skipped (no downgrade) and credentials are never sent unencrypted.
 */
export function smtpSender(url: string, opts: SmtpOptions = {}): MailSender {
  const u = new URL(url);
  const secure = u.protocol === 'smtps:', starttls = u.protocol === 'smtp+starttls:';
  const port = Number(u.port || (secure ? 465 : starttls ? 587 : 25)); const host = hostOf(u);
  const user = u.username ? decodeURIComponent(u.username) : '', pass = decodeURIComponent(u.password);
  const timeout = opts.timeoutMs ?? 15_000;
  const guard = !!opts.publicOnly && !allowPrivateSmtp();
  // net/tls skip `lookup` for IP literals, so those are checked here; names are checked by guardedLookup on the address actually used.
  const lookup = guard ? guardedLookup : undefined;
  const tlsOpts = { host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: true, ca: opts.ca, lookup };
  return {
    async send(m): Promise<MailResult> {
      const from = clean(m.from ?? FROM()), to = clean(m.to);
      let sock!: Socket;
      let buf = '', wake: (() => void) | null = null, err: Error | null = null, closed = false;
      const hook = (s: Socket) => {
        s.on('data', (d) => { buf += d.toString('utf8'); wake?.(); });
        s.on('error', (e) => { err = e; wake?.(); });
        s.on('close', () => { closed = true; wake?.(); });
        s.setTimeout(timeout, () => { err = new Error('smtp timeout'); wake?.(); });
      };
      const fail = (e: unknown): never => {
        const code = (e as { code?: string }).code ?? '';
        if (e instanceof SmtpError) throw e;
        if (e instanceof SmtpTargetError) throw new SmtpError('smtp target not allowed', 'target_blocked', 'permanent');
        if (CERT_ERR.test(code)) throw new SmtpError('tls certificate rejected', 'tls_cert_invalid', 'permanent');
        throw new SmtpError('smtp connection failed', code === 'ECONNREFUSED' ? 'connect_refused' : /timeout/i.test(String((e as Error).message)) ? 'timeout' : 'connect_failed', 'transient');
      };
      const reply = async (): Promise<string> => {
        for (;;) {
          const lines = buf.split('\r\n'); const last = lines.length > 1 ? lines[lines.length - 2] : '';
          if (last && /^\d{3} /.test(last)) { const out = buf; buf = ''; return out; }   // final line of a (multi-line) reply
          if (err) throw err;
          if (closed) throw new Error('smtp connection closed');
          await new Promise<void>((r) => { wake = r; });
        }
      };
      const verdict = (r: string, what: string): never => { throw new SmtpError(`smtp ${what} ${r.slice(0, 3)}`, `smtp_${r.slice(0, 3)}`, r[0] === '5' ? 'permanent' : 'transient'); };
      const cmd = async (line: string, ok: string, what: string): Promise<string> => {
        sock.write(`${line}\r\n`); const r = await reply();
        if (!r.startsWith(ok)) { if (/^53[0-5]/.test(r) && what === 'auth') throw new SmtpError('smtp auth failed', 'auth_failed', 'permanent'); verdict(r, what); }
        return r;
      };
      try {
        try {
          if (guard && isIP(host) && isBlockedAddress(host)) throw new SmtpTargetError('smtp_host_blocked');
          sock = secure ? tls(tlsOpts) : tcp({ host, port, lookup }); hook(sock);
          if (!(await reply()).startsWith('220')) throw new SmtpError('smtp greeting', 'smtp_greeting', 'transient');
          let caps = await cmd('EHLO csai', '250', 'ehlo');
          let encrypted = secure;
          if (starttls) {
            if (!/^250[- ]STARTTLS\b/im.test(caps)) throw new SmtpError('server does not offer STARTTLS', 'starttls_unsupported', 'permanent');   // never fall back to plaintext
            await cmd('STARTTLS', '220', 'starttls');
            sock.removeAllListeners(); buf = ''; closed = false;
            sock = tls({ ...tlsOpts, socket: sock }); hook(sock);
            await new Promise<void>((res, rej) => { sock.once('secureConnect', () => res()); sock.once('error', rej); });
            encrypted = true; caps = await cmd('EHLO csai', '250', 'ehlo');
          }
          if (user) {
            if (!encrypted) throw new SmtpError('refusing to send credentials without TLS', 'auth_requires_tls', 'permanent');
            const mech = /^250[- ]AUTH\b(.*)$/im.exec(caps)?.[1].toUpperCase() ?? '';
            if (mech.includes('PLAIN')) await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, '235', 'auth');
            else if (mech.includes('LOGIN')) { await cmd('AUTH LOGIN', '334', 'auth'); await cmd(Buffer.from(user).toString('base64'), '334', 'auth'); await cmd(Buffer.from(pass).toString('base64'), '235', 'auth'); }
            else throw new SmtpError('no supported AUTH mechanism', 'auth_unsupported', 'permanent');
          }
          await cmd(`MAIL FROM:<${from}>`, '250', 'mail');
          await cmd(`RCPT TO:<${to}>`, '250', 'rcpt');
          await cmd('DATA', '354', 'data');
        } catch (e) { fail(e); }
        // ---- point of no return: after the body is written, a lost connection means "maybe delivered" ----
        const body = m.text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');   // dot-stuffing
        const hdr = [m.messageId && `Message-ID: <${clean(m.messageId)}>`, m.inReplyTo && `In-Reply-To: <${clean(m.inReplyTo)}>`, m.references?.length && `References: ${m.references.map((r) => `<${clean(r)}>`).join(' ')}`].filter(Boolean).join('\r\n');
        const display = m.fromName ? `${encWord(clean(m.fromName).replace(/["\\]/g, ''))} <${from}>` : from;
        sock.write(`From: ${display}\r\nTo: ${to}\r\nDate: ${new Date().toUTCString()}\r\n${hdr ? `${hdr}\r\n` : ''}Subject: =?UTF-8?B?${Buffer.from(clean(m.subject)).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n.\r\n`);
        let r: string;
        try { r = await reply(); } catch { throw new SmtpError('connection lost before the server confirmed the message', 'uncertain_delivery', 'uncertain'); }
        if (!r.startsWith('250')) verdict(r, 'data');
        sock.write('QUIT\r\n');
        return { ref: r.replace(/^250[ -]/, '').replace(/[^A-Za-z0-9 ._:#=@-]/g, '').trim().slice(0, 64) || undefined };
      } finally { sock?.destroy(); }
    },
  };
}

export function mailSender(): MailSender | null {
  switch (process.env.MAIL_TRANSPORT) {
    case 'mailpit': return mailpitSender(process.env.MAIL_HTTP_URL ?? 'http://127.0.0.1:54324');
    case 'smtp': return process.env.MAIL_SMTP_URL ? smtpSender(process.env.MAIL_SMTP_URL) : null;
    default: return null;
  }
}

/** Invitation e-mail. The link is the only secret in it; it is never logged. Returns false when no transport is configured or sending failed (invitation stays valid; admin can resend). */
export async function sendInvitationMail(to: string, orgName: string, acceptUrl: string, expiresAt: string): Promise<boolean> {
  const s = mailSender(); if (!s) return false;
  try {
    await s.send({ to, subject: `[${clean(orgName)}] 초대가 도착했습니다`, text: `${orgName}에서 AI Customer Operations에 초대했습니다.\n\n아래 링크에서 수락하세요 (${expiresAt.slice(0, 10)}까지 유효, 1회용):\n${acceptUrl}\n\n본인이 요청한 초대가 아니라면 이 메일을 무시하세요.\n` });
    return true;
  } catch { return false; }
}

/** One-time proof-of-mailbox code for invitation sign-up. The code is the only secret in the mail and is never logged. Returns false when no transport is configured or sending failed. */
export async function sendInviteCodeMail(to: string, code: string): Promise<boolean> {
  const s = mailSender(); if (!s) return false;
  try {
    await s.send({ to, subject: '[AI Customer Operations] 이메일 확인 코드', text: `초대를 수락하려면 아래 확인 코드를 입력하세요 (30분 이내, 1회용):\n\n${code}\n\n본인이 요청하지 않았다면 이 메일을 무시하세요. 코드를 다른 사람에게 알려 주지 마세요.\n` });
    return true;
  } catch { return false; }
}
