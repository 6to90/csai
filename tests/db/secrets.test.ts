import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSecrets, type SecretsStore } from '@/server/security/secrets';
import { mkOrg, mkUser, rejects, sup, svc, user } from './helpers';

// SecretsStore over a real Postgres (service-role semantics), so the real crypto writes to the real tables.
const store: SecretsStore = {
  async getOrgKey(o) { const r = await sup<{ wrapped_key: Buffer; key_version: number }>('select wrapped_key,key_version from org_keys where org_id=$1', [o]); return r[0] ? { wrapped: r[0].wrapped_key, version: r[0].key_version } : null; },
  async createOrgKey(o, w) { return (await sup('insert into org_keys(org_id,wrapped_key) values ($1,$2) on conflict do nothing returning 1', [o, w])).length === 1; },
  async listOrgKeys() { return (await sup<{ org_id: string; wrapped_key: Buffer; key_version: number }>('select * from org_keys')).map((r) => ({ orgId: r.org_id, wrapped: r.wrapped_key, version: r.key_version })); },
  async setWrappedKey(o, w, v) { await sup('update org_keys set wrapped_key=$2 where org_id=$1 and key_version=$3', [o, w, v]); },
  async upsertSecret(r) { await sup('insert into integration_secrets(org_id,integration_id,name,ciphertext,key_version,last4) values ($1,$2,$3,$4,$5,$6) on conflict (integration_id,name) do update set ciphertext=excluded.ciphertext, key_version=excluded.key_version, last4=excluded.last4', [r.orgId, r.integrationId, r.name, r.ciphertext, r.keyVersion, r.last4]); },
  async getSecret(o, i, n) { const r = await sup<{ ciphertext: Buffer; key_version: number }>('select ciphertext,key_version from integration_secrets where org_id=$1 and integration_id=$2 and name=$3', [o, i, n]); return r[0] ? { ciphertext: r[0].ciphertext, keyVersion: r[0].key_version } : null; },
  async listSecrets(o) { return (await sup<{ id: string; integration_id: string; name: string; ciphertext: Buffer; key_version: number }>('select * from integration_secrets where org_id=$1', [o])).map((r) => ({ id: r.id, integrationId: r.integration_id, name: r.name, ciphertext: r.ciphertext, keyVersion: r.key_version })); },
  async rotate(o, w, v, s) { await sup('select rotate_org_key($1,$2,$3,$4)', [o, w.toString('hex'), v, JSON.stringify(s.map((x) => ({ id: x.id, ciphertext: x.ciphertext.toString('hex') })))]); },
};
const master = randomBytes(32);
const PLAIN = 'sk-live-SUPERSECRET-API-KEY-1234';
let org: string, integ: string, owner: { id: string };

beforeAll(async () => {
  owner = await mkUser('so'); org = await mkOrg(owner.id);
  integ = (await sup<{ id: string }>(`insert into integrations(org_id,kind,name) values ($1,'http_connector','c') returning id`, [org]))[0].id;
});

describe('secrets at rest (real tables)', () => {
  it('stores only ciphertext + last4; plaintext and master key never appear in any row', async () => {
    const s = createSecrets(store, { current: master });
    expect(await s.put(org, integ, 'api_key', PLAIN)).toEqual({ name: 'api_key', last4: '1234' });
    expect(await s.get(org, integ, 'api_key')).toBe(PLAIN);
    for (const t of ['integration_secrets', 'org_keys', 'audit_logs', 'integrations']) {
      const dump = (await sup<{ d: string }>(`select string_agg(x::text, ' ') d from ${t} x`))[0].d ?? '';
      expect(dump).not.toContain(PLAIN); expect(dump).not.toContain('SUPERSECRET');
      expect(dump).not.toContain(master.toString('hex')); expect(dump).not.toContain(master.toString('base64'));
    }
    const [row] = await sup<{ ciphertext: Buffer }>('select ciphertext from integration_secrets where org_id=$1', [org]);
    expect(row.ciphertext.includes(Buffer.from(PLAIN))).toBe(false);
  });
  it('app roles cannot read org_keys or integration_secrets', async () => {
    await rejects(user(owner.id, 'select * from integration_secrets'), /permission denied/);
    await rejects(user(owner.id, 'select * from org_keys'), /permission denied/);
    await rejects(user(owner.id, `insert into integration_secrets(org_id,integration_id,name,ciphertext,key_version,last4) values ($1,$2,'x','\\x00',1,'')`, [org, integ]), /permission denied/);
  });
  it('rotateOrgKey re-encrypts atomically; old ciphertext dies, value survives', async () => {
    const s = createSecrets(store, { current: master });
    await s.put(org, integ, 'second', 'another-secret-value');
    const before = await sup<{ ciphertext: Buffer }>('select ciphertext from integration_secrets where org_id=$1 order by name', [org]);
    expect(await s.rotateOrgKey(org)).toBe(2);
    const after = await sup<{ ciphertext: Buffer; key_version: number }>('select ciphertext,key_version from integration_secrets where org_id=$1 order by name', [org]);
    expect(after.every((r, i) => !r.ciphertext.equals(before[i].ciphertext) && r.key_version === 2)).toBe(true);
    expect(await s.get(org, integ, 'api_key')).toBe(PLAIN);
  });
  it('rotate_org_key refuses a stale version and incomplete secret sets (no partial write)', async () => {
    const snap = await sup('select ciphertext from integration_secrets where org_id=$1 order by name', [org]);
    await rejects(sup('select rotate_org_key($1,$2,2,$3)', [org, 'aa', '[]']), /conflict/);               // version 2 is current; expects 3
    await rejects(sup('select rotate_org_key($1,$2,3,$3)', [org, 'aa', '[]']), /rotation incomplete/);    // zero of two secrets supplied
    expect(await sup('select ciphertext from integration_secrets where org_id=$1 order by name', [org])).toEqual(snap);
    expect((await sup<{ key_version: number }>('select key_version from org_keys where org_id=$1', [org]))[0].key_version).toBe(2);
  });
  it('master key rotation: rewrap with new key, old key no longer needed', async () => {
    const next = randomBytes(32);
    const rotating = createSecrets(store, { current: next, previous: master });
    const rw = await rotating.rewrapAll(); expect(rw.rewrapped).toBeGreaterThanOrEqual(1); expect(rw.failed).not.toContain(org);   // other orgs/DB leftovers may legitimately fail
    expect(await createSecrets(store, { current: next }).get(org, integ, 'api_key')).toBe(PLAIN);
    await expect(createSecrets(store, { current: master }).get(org, integ, 'api_key')).rejects.toThrow(/master key not available/);
  });
});
