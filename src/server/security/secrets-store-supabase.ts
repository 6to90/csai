import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SecretsStore } from './secrets';

// PostgREST represents bytea as '\x<hex>'.
const toPg = (b: Buffer) => `\\x${b.toString('hex')}`;
const fromPg = (s: string) => Buffer.from(s.replace(/^\\x/, ''), 'hex');
const fail = (e: { message: string } | null) => { if (e) throw new Error(`secrets store: ${e.message}`); };

/** service_role client only. NOTE: not yet verified against a live PostgREST (no Docker in the Phase 2 environment). */
export function supabaseSecretsStore(db: SupabaseClient): SecretsStore {
  return {
    async getOrgKey(orgId) {
      const { data, error } = await db.from('org_keys').select('wrapped_key,key_version').eq('org_id', orgId).maybeSingle(); fail(error);
      return data ? { wrapped: fromPg(data.wrapped_key), version: data.key_version } : null;
    },
    async createOrgKey(orgId, wrapped) {
      const { error } = await db.from('org_keys').insert({ org_id: orgId, wrapped_key: toPg(wrapped) });
      if (error?.code === '23505') return false; fail(error); return true;
    },
    async listOrgKeys() {
      const { data, error } = await db.from('org_keys').select('org_id,wrapped_key,key_version'); fail(error);
      return (data ?? []).map((r) => ({ orgId: r.org_id, wrapped: fromPg(r.wrapped_key), version: r.key_version }));
    },
    async setWrappedKey(orgId, wrapped, expectedVersion) {
      const { data, error } = await db.from('org_keys').update({ wrapped_key: toPg(wrapped) }).eq('org_id', orgId).eq('key_version', expectedVersion).select('org_id'); fail(error);
      if (!data?.length) throw new Error('secrets store: key version changed during rewrap');
    },
    async upsertSecret(r) {
      const { error } = await db.from('integration_secrets').upsert(
        { org_id: r.orgId, integration_id: r.integrationId, name: r.name, ciphertext: toPg(r.ciphertext), key_version: r.keyVersion, last4: r.last4, rotated_at: new Date().toISOString() },
        { onConflict: 'integration_id,name' }); fail(error);
    },
    async getSecret(orgId, integrationId, name) {
      const { data, error } = await db.from('integration_secrets').select('ciphertext,key_version').eq('org_id', orgId).eq('integration_id', integrationId).eq('name', name).maybeSingle(); fail(error);
      return data ? { ciphertext: fromPg(data.ciphertext), keyVersion: data.key_version } : null;
    },
    async listSecrets(orgId) {
      const { data, error } = await db.from('integration_secrets').select('id,integration_id,name,ciphertext,key_version').eq('org_id', orgId); fail(error);
      return (data ?? []).map((r) => ({ id: r.id, integrationId: r.integration_id, name: r.name, ciphertext: fromPg(r.ciphertext), keyVersion: r.key_version }));
    },
    async rotate(orgId, newWrapped, newVersion, secrets) {
      const { error } = await db.rpc('rotate_org_key', { p_org: orgId, p_wrapped_hex: newWrapped.toString('hex'), p_new_version: newVersion, p_secrets: secrets.map((s) => ({ id: s.id, ciphertext: s.ciphertext.toString('hex') })) }); fail(error);
    },
  };
}
