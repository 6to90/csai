import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecrets, masterKeysFromEnv, type SecretsStore } from '@/server/security/secrets';

function memStore() {
  const keys = new Map<string, { wrapped: Buffer; version: number }>();
  const secrets = new Map<string, { id: string; orgId: string; integrationId: string; name: string; ciphertext: Buffer; keyVersion: number }>();
  const k = (i: string, n: string) => `${i}/${n}`;
  const store: SecretsStore = {
    async getOrgKey(o) { return keys.get(o) ?? null; },
    async createOrgKey(o, w) { if (keys.has(o)) return false; keys.set(o, { wrapped: w, version: 1 }); return true; },
    async listOrgKeys() { return [...keys].map(([orgId, v]) => ({ orgId, ...v })); },
    async setWrappedKey(o, w, v) { const c = keys.get(o); if (!c || c.version !== v) throw new Error('version'); keys.set(o, { wrapped: w, version: v }); },
    async upsertSecret(r) { const ex = secrets.get(k(r.integrationId, r.name)); secrets.set(k(r.integrationId, r.name), { id: ex?.id ?? `id-${secrets.size}`, orgId: r.orgId, integrationId: r.integrationId, name: r.name, ciphertext: r.ciphertext, keyVersion: r.keyVersion }); },
    async getSecret(o, i, n) { const s = secrets.get(k(i, n)); return s && s.orgId === o ? { ciphertext: s.ciphertext, keyVersion: s.keyVersion } : null; },
    async listSecrets(o) { return [...secrets.values()].filter((s) => s.orgId === o); },
    async rotate(o, w, v, ss) { keys.set(o, { wrapped: w, version: v }); for (const s of ss) for (const [kk, cur] of secrets) if (cur.id === s.id) secrets.set(kk, { ...cur, ciphertext: s.ciphertext, keyVersion: v }); },
  };
  return { store, keys, secrets };
}
const master = randomBytes(32);

describe('secrets envelope encryption', () => {
  it('round-trips; stored blobs contain no plaintext; put returns metadata only', async () => {
    const m = memStore(); const s = createSecrets(m.store, { current: master });
    const meta = await s.put('org1', 'int1', 'api_key', 'sk-very-secret-9999');
    expect(meta).toEqual({ name: 'api_key', last4: '9999' });
    expect(await s.get('org1', 'int1', 'api_key')).toBe('sk-very-secret-9999');
    const ct = [...m.secrets.values()][0].ciphertext;
    expect(ct.includes(Buffer.from('very-secret'))).toBe(false);
    expect(m.keys.get('org1')!.wrapped.includes(master)).toBe(false);
  });
  it('encrypting twice yields different ciphertexts (random IV)', async () => {
    const m = memStore(); const s = createSecrets(m.store, { current: master });
    await s.put('o', 'i', 'a', 'same-value-12345'); const c1 = [...m.secrets.values()][0].ciphertext;
    await s.put('o', 'i', 'a', 'same-value-12345'); const c2 = [...m.secrets.values()][0].ciphertext;
    expect(c1.equals(c2)).toBe(false);
  });
  it('detects tampering and rejects ciphertext moved to another secret/org (AAD binding)', async () => {
    const m = memStore(); const s = createSecrets(m.store, { current: master });
    await s.put('o', 'i', 'a', 'value-aaaaaaaa'); await s.put('o', 'i', 'b', 'value-bbbbbbbb');
    const a = m.secrets.get('i/a')!; const b = m.secrets.get('i/b')!;
    b.ciphertext = Buffer.from(a.ciphertext);                       // swap
    await expect(s.get('o', 'i', 'b')).rejects.toThrow();
    a.ciphertext[a.ciphertext.length - 1] ^= 1;                    // flip a tag bit
    await expect(s.get('o', 'i', 'a')).rejects.toThrow();
  });
  it('per-org keys: org2 cannot decrypt org1 data', async () => {
    const m = memStore(); const s = createSecrets(m.store, { current: master });
    await s.put('org1', 'i', 'a', 'value-aaaaaaaa');
    const stolen = m.secrets.get('i/a')!; m.secrets.set('i/a', { ...stolen, orgId: 'org2' });
    await s.put('org2', 'other', 'x', 'value-xxxxxxxx');
    await expect(s.get('org2', 'i', 'a')).rejects.toThrow();
  });
  it('wrong master key cannot unwrap; previous key still works during rotation', async () => {
    const m = memStore(); await createSecrets(m.store, { current: master }).put('o', 'i', 'a', 'value-aaaaaaaa');
    const other = randomBytes(32);
    await expect(createSecrets(m.store, { current: other }).get('o', 'i', 'a')).rejects.toThrow(/master key not available/);
    expect(await createSecrets(m.store, { current: other, previous: master }).get('o', 'i', 'a')).toBe('value-aaaaaaaa');
  });
  it('rewrapAll moves to the new master key without touching secrets', async () => {
    const m = memStore(); await createSecrets(m.store, { current: master }).put('o', 'i', 'a', 'value-aaaaaaaa');
    const ctBefore = Buffer.from(m.secrets.get('i/a')!.ciphertext); const next = randomBytes(32);
    expect(await createSecrets(m.store, { current: next, previous: master }).rewrapAll()).toEqual({ rewrapped: 1, failed: [] });
    expect(m.secrets.get('i/a')!.ciphertext.equals(ctBefore)).toBe(true);
    expect(await createSecrets(m.store, { current: next }).get('o', 'i', 'a')).toBe('value-aaaaaaaa');
  });
  it('rotateOrgKey re-encrypts all secrets under a new key version', async () => {
    const m = memStore(); const s = createSecrets(m.store, { current: master });
    await s.put('o', 'i', 'a', 'value-aaaaaaaa'); await s.put('o', 'i', 'b', 'value-bbbbbbbb');
    const before = Buffer.from(m.secrets.get('i/a')!.ciphertext);
    expect(await s.rotateOrgKey('o')).toBe(2);
    expect(m.secrets.get('i/a')!.ciphertext.equals(before)).toBe(false);
    expect(m.keys.get('o')!.version).toBe(2);
    expect(await s.get('o', 'i', 'a')).toBe('value-aaaaaaaa'); expect(await s.get('o', 'i', 'b')).toBe('value-bbbbbbbb');
  });
  it('master key must be 32 bytes base64', () => {
    expect(() => masterKeysFromEnv({ SECRETS_MASTER_KEY: 'short' } as never)).toThrow(/32 bytes/);
    expect(() => masterKeysFromEnv({} as never)).toThrow();
    expect(masterKeysFromEnv({ SECRETS_MASTER_KEY: master.toString('base64') } as never).current.length).toBe(32);
  });
});
