import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
import { smtpSender, SmtpError } from '@/server/adapters/mail';
import { assertPublicHost, assertSmtpUrlAllowed, isBlockedAddress, makeGuardedLookup, parseSmtpTarget, SmtpTargetError } from '@/server/security/net-guard';

beforeEach(() => { delete process.env.SMTP_ALLOW_PRIVATE_HOSTS; });
afterEach(() => vi.restoreAllMocks());

describe('address classification', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254' /* cloud metadata */, '100.64.0.1' /* CGNAT */, '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '100::1', 'not-an-ip', '',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1', '2606:4700:4700::1111', '2a00:1450:4009::65'])('allows public %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('SMTP URL policy', () => {
  it.each([
    ['http://smtp.example.com:25', 'smtp_protocol_not_allowed'], ['file:///etc/passwd', 'smtp_protocol_not_allowed'], ['ftp://x.example.com', 'smtp_protocol_not_allowed'],
    ['smtp://user:pass@smtp.example.com:25', 'smtp_plaintext_credentials'], ['smtps://smtp.example.com:6379', 'smtp_port_not_allowed'], ['smtps://smtp.example.com:22', 'smtp_port_not_allowed'],
    ['smtp+starttls://smtp.example.com:5432', 'smtp_port_not_allowed'], ['smtps://smtp.example.com/path', 'smtp_url_invalid'], ['smtps://smtp.example.com:465?x=1', 'smtp_url_invalid'], ['smtps://', 'smtp_url_invalid'], ['nonsense', 'smtp_url_invalid'],
  ])('rejects %s', (u, code) => expect(() => parseSmtpTarget(u)).toThrow(expect.objectContaining({ code })));
  it.each([['smtps://u:p@smtp.example.com', 465], ['smtps://smtp.example.com:465', 465], ['smtp+starttls://smtp.example.com', 587], ['smtp://smtp.example.com', 25], ['smtp+starttls://smtp.example.com:2525', 2525]])('accepts %s', (u, port) => {
    expect(parseSmtpTarget(u).port).toBe(port);
  });
  it('rejects literal private/loopback/metadata hosts and encoded IP forms before any connection', async () => {
    for (const u of ['smtps://127.0.0.1:465', 'smtps://[::1]:465', 'smtp://169.254.169.254:25', 'smtps://10.1.2.3:465', 'smtps://[::ffff:127.0.0.1]:465', 'smtps://localhost:465', 'smtps://mail.localhost:465', 'smtps://db.internal:465']) {
      await expect(assertSmtpUrlAllowed(u), u).rejects.toBeInstanceOf(SmtpTargetError);
    }
    // decimal / hex / octal spellings of 127.0.0.1 are resolved by the OS resolver and rejected on the resulting address
    const sys = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    for (const u of ['smtps://2130706433:465', 'smtps://0x7f.1:465', 'smtps://017700000001:465']) await expect(assertSmtpUrlAllowed(u), u).rejects.toMatchObject({ code: 'smtp_host_blocked' });
    expect(sys).toHaveBeenCalled();
  });
  it('rejects a name if ANY resolved address is internal (mixed A/AAAA answers)', async () => {
    const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }];
    await expect(assertPublicHost('evil.example.com', mixed)).rejects.toMatchObject({ code: 'smtp_host_blocked' });
    await expect(assertPublicHost('evil.example.com', async () => [{ address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 }])).rejects.toMatchObject({ code: 'smtp_host_blocked' });
  });
  it('fails closed when the name does not resolve', async () => {
    await expect(assertPublicHost('nx.example.com', async () => { throw new Error('ENOTFOUND'); })).rejects.toMatchObject({ code: 'smtp_host_unresolvable' });
    await expect(assertPublicHost('empty.example.com', async () => [])).rejects.toMatchObject({ code: 'smtp_host_unresolvable' });
  });
  it('accepts a genuinely public host (normal SMTP keeps working)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    await expect(assertSmtpUrlAllowed('smtps://user:pw@smtp.example.com:465')).resolves.toMatchObject({ host: 'smtp.example.com', port: 465 });
  });
  it('the private-host opt-in is OFF by default (also in production) and only an explicit SMTP_ALLOW_PRIVATE_HOSTS=1 enables it', async () => {
    const env = process.env as Record<string, string | undefined>; const prev = env.NODE_ENV;
    try {
      env.NODE_ENV = 'production';
      await expect(assertSmtpUrlAllowed('smtps://127.0.0.1:465')).rejects.toBeInstanceOf(SmtpTargetError);
      env.SMTP_ALLOW_PRIVATE_HOSTS = 'true'; await expect(assertSmtpUrlAllowed('smtps://127.0.0.1:465')).rejects.toBeInstanceOf(SmtpTargetError);   // only the literal "1"
      env.SMTP_ALLOW_PRIVATE_HOSTS = '1'; await expect(assertSmtpUrlAllowed('smtps://127.0.0.1:4465')).resolves.toBeTruthy();
    } finally { env.NODE_ENV = prev; delete env.SMTP_ALLOW_PRIVATE_HOSTS; }
  });
});

describe('DNS rebinding: the address is re-validated at connect time', () => {
  it('a name that was public when saved but resolves internally at send time is refused', async () => {
    let calls = 0;
    const flip = async () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]);
    await assertPublicHost('rebind.example.com', flip);                     // save time: passes
    const lookup = makeGuardedLookup(flip);                                 // connect time: second answer is the metadata IP
    const err = await new Promise<Error | null>((res) => lookup('rebind.example.com', { family: 0 }, (e) => res(e)));
    expect(err).toBeInstanceOf(SmtpTargetError);
  });
  it('returns the vetted address (and honours all:true) when the answer is public', async () => {
    const l = makeGuardedLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    expect(await new Promise((res) => l('ok.example.com', { all: false }, (_e, a, f) => res([a, f])))).toEqual(['93.184.216.34', 4]);
    expect(await new Promise((res) => l('ok.example.com', { all: true }, (_e, a) => res(a)))).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('smtpSender({ publicOnly }) never opens a socket to an internal target', () => {
  let srv: Server; let conns = 0; let port = 0; let socks: import('node:net').Socket[] = [];
  beforeEach(async () => { conns = 0; socks = []; srv = createServer((s) => { conns++; socks.push(s); s.on('error', () => {}); s.end('220 hi\r\n'); }); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); port = (srv.address() as { port: number }).port; });
  afterEach(() => new Promise<void>((r) => { socks.forEach((x) => x.destroy()); srv.close(() => r()); }));
  const msg = { to: 'a@example.com', subject: 's', text: 't' };
  it('IP literal loopback is blocked and the listening server sees zero connections', async () => {
    await expect(smtpSender(`smtp://127.0.0.1:${port}`, { publicOnly: true }).send(msg)).rejects.toMatchObject({ code: 'target_blocked', kind: 'permanent' });
    expect(conns).toBe(0);
  });
  it('a hostname that resolves to loopback (localhost) is blocked at connect time; zero connections', async () => {
    await expect(smtpSender(`smtp://localhost:${port}`, { publicOnly: true }).send(msg)).rejects.toBeInstanceOf(SmtpError);
    expect(conns).toBe(0);
  });
  it('without publicOnly (operator-configured transport) loopback still works, so existing behaviour is unchanged', async () => {
    await smtpSender(`smtp://127.0.0.1:${port}`).send(msg).catch(() => {});
    expect(conns).toBe(1);
  });
});
