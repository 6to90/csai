// TEST HARNESS ONLY — NOT GoTrue. Fronts a real PostgREST at /rest/v1 and answers GET /auth/v1/user for HS256 test JWTs.
// It exists so the Next.js API can be exercised end-to-end when Docker/Supabase is unavailable. It proves nothing about real GoTrue.
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const { JWT_SECRET, DATABASE_URL, POSTGREST_PORT = '54320', PORT = '54321' } = process.env;
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
const b64 = (b) => Buffer.from(b).toString('base64url');

function verify(token) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const exp = createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  return claims.exp && claims.exp * 1000 > Date.now() ? claims : null;
}

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/rest/v1/')) {
      const up = http.request({ host: '127.0.0.1', port: POSTGREST_PORT, path: req.url.slice('/rest/v1'.length), method: req.method, headers: { ...req.headers, host: `127.0.0.1:${POSTGREST_PORT}` } },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); });
      return void req.pipe(up);
    }
    if (process.env.STUB_DEBUG) console.error(req.method, req.url, req.headers.authorization ? 'auth' : 'noauth');
    if (req.url.startsWith('/auth/v1/user') && req.method === 'GET') {
      const claims = verify((req.headers.authorization ?? '').replace(/^Bearer /i, ''));
      if (process.env.STUB_DEBUG) console.error('claims', claims && { role: claims.role, sub: claims.sub });
      if (!claims || claims.role !== 'authenticated') { res.writeHead(401, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ code: 401, msg: 'invalid JWT' })); }
      const { rows } = await pool.query('select id, email, email_confirmed_at from auth.users where id = $1', [claims.sub]);
      if (process.env.STUB_DEBUG) console.error('rows', rows.length, claims.sub);
      if (!rows[0]) { res.writeHead(401, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ code: 401, msg: 'user not found' })); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ ...rows[0], aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }));
    }
    res.writeHead(404); res.end();
  } catch (e) { if (process.env.STUB_DEBUG) console.error('stub error', e.message); res.writeHead(500); res.end(); }
}).listen(Number(PORT), '127.0.0.1');
