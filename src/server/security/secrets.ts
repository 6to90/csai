import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { last4 } from './mask';

/**
 * Envelope encryption (ARCHITECTURE §6.4 / DATABASE §7).
 * - per-org data key (random 32B) is wrapped with a master key from ENV (never stored beside the ciphertext)
 * - secrets are AES-256-GCM encrypted with the data key; AAD binds ciphertext to org+integration+name
 * Blob layouts:  wrapped = keyId(4) | iv(12) | ct | tag(16)    secret = iv(12) | ct | tag(16)
 */
export interface SecretsStore {
  getOrgKey(orgId: string): Promise<{ wrapped: Buffer; version: number } | null>;
  createOrgKey(orgId: string, wrapped: Buffer): Promise<boolean>; // false if it already exists (race)
  listOrgKeys(): Promise<{ orgId: string; wrapped: Buffer; version: number }[]>;
  setWrappedKey(orgId: string, wrapped: Buffer, expectedVersion: number): Promise<void>; // re-wrap only; version unchanged
  upsertSecret(row: { orgId: string; integrationId: string; name: string; ciphertext: Buffer; keyVersion: number; last4: string }): Promise<void>;
  getSecret(orgId: string, integrationId: string, name: string): Promise<{ ciphertext: Buffer; keyVersion: number } | null>;
  listSecrets(orgId: string): Promise<{ id: string; integrationId: string; name: string; ciphertext: Buffer; keyVersion: number }[]>;
  rotate(orgId: string, newWrapped: Buffer, newVersion: number, secrets: { id: string; ciphertext: Buffer }[]): Promise<void>; // atomic
}

const keyId = (k: Buffer) => createHash('sha256').update(k).digest().subarray(0, 4);

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}
function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < 12 + 16) throw new Error('invalid ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
}

export function parseMasterKey(b64: string | undefined, name: string): Buffer {
  const k = Buffer.from(b64 ?? '', 'base64');
  if (k.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return k;
}
export function masterKeysFromEnv(env = process.env): { current: Buffer; previous?: Buffer } {
  const current = parseMasterKey(env.SECRETS_MASTER_KEY, 'SECRETS_MASTER_KEY');
  const previous = env.SECRETS_MASTER_KEY_PREVIOUS ? parseMasterKey(env.SECRETS_MASTER_KEY_PREVIOUS, 'SECRETS_MASTER_KEY_PREVIOUS') : undefined;
  return { current, previous };
}

export function createSecrets(store: SecretsStore, masters: { current: Buffer; previous?: Buffer }) {
  const wrap = (dataKey: Buffer, orgId: string) => Buffer.concat([keyId(masters.current), seal(masters.current, dataKey, `orgkey:${orgId}`)]);
  const unwrap = (blob: Buffer, orgId: string): Buffer => {
    const id = blob.subarray(0, 4);
    const m = [masters.current, masters.previous].find((k) => k && keyId(k).equals(id));
    if (!m) throw new Error('master key not available for this wrapped key');
    return open(m, blob.subarray(4), `orgkey:${orgId}`);
  };
  const aad = (orgId: string, integrationId: string, name: string) => `secret:${orgId}:${integrationId}:${name}`;

  async function dataKey(orgId: string, create: boolean): Promise<{ key: Buffer; version: number } | null> {
    let row = await store.getOrgKey(orgId);
    if (!row && create) {
      await store.createOrgKey(orgId, wrap(randomBytes(32), orgId)); // loser of a race simply re-reads
      row = await store.getOrgKey(orgId);
    }
    return row ? { key: unwrap(row.wrapped, orgId), version: row.version } : null;
  }

  return {
    /** Write-only API: returns only metadata, never the value. */
    async put(orgId: string, integrationId: string, name: string, value: string) {
      const k = (await dataKey(orgId, true))!;
      const l4 = last4(value);
      await store.upsertSecret({ orgId, integrationId, name, ciphertext: seal(k.key, Buffer.from(value, 'utf8'), aad(orgId, integrationId, name)), keyVersion: k.version, last4: l4 });
      return { name, last4: l4 };
    },
    /** Server-internal use only, right before the call that needs it. Never return this from an API route. */
    async get(orgId: string, integrationId: string, name: string): Promise<string | null> {
      const [row, k] = await Promise.all([store.getSecret(orgId, integrationId, name), dataKey(orgId, false)]);
      if (!row || !k) return null;
      if (row.keyVersion !== k.version) throw new Error('secret key version mismatch');
      return open(k.key, row.ciphertext, aad(orgId, integrationId, name)).toString('utf8');
    },
    /** Master-key rotation: set new SECRETS_MASTER_KEY, keep old as _PREVIOUS, run this, then drop _PREVIOUS. */
    async rewrapAll(): Promise<{ rewrapped: number; failed: string[] }> {
      const failed: string[] = [];
      let rewrapped = 0;
      for (const r of await store.listOrgKeys()) {
        try { await store.setWrappedKey(r.orgId, wrap(unwrap(r.wrapped, r.orgId), r.orgId), r.version); rewrapped++; }
        catch { failed.push(r.orgId); }   // one unreadable org (unknown master key / concurrent rotation) must not abort the rest; caller must check `failed` before dropping the old key
      }
      return { rewrapped, failed };
    },
    /** Data-key rotation: re-encrypt every secret of the org under a new key, atomically. */
    async rotateOrgKey(orgId: string): Promise<number> {
      const cur = await dataKey(orgId, false);
      if (!cur) return 0;
      const next = randomBytes(32);
      const secrets = (await store.listSecrets(orgId)).map((s) => ({
        id: s.id,
        ciphertext: seal(next, open(cur.key, s.ciphertext, aad(orgId, s.integrationId, s.name)), aad(orgId, s.integrationId, s.name)),
      }));
      await store.rotate(orgId, wrap(next, orgId), cur.version + 1, secrets);
      return secrets.length;
    },
  };
}
