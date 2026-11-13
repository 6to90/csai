import 'server-only';
import { redact } from './mask';
import { systemClient } from './system-client';
import { HttpError } from '../http';

export interface AuditEntry {
  orgId: string; actorType: 'user' | 'ai_agent' | 'system'; actorId?: string | null;
  action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown>; ip?: string; requestId?: string;
}
/**
 * For changes NOT done inside a DB RPC. Security-critical changes must instead be made in an RPC that calls append_audit
 * in the same transaction (DATABASE §5). Metadata is redacted here and checked again by the DB function.
 */
export async function audit(e: AuditEntry): Promise<void> {
  const { error } = await systemClient().rpc('append_audit', {
    p_org: e.orgId, p_actor_type: e.actorType, p_actor_id: e.actorId ?? null, p_action: e.action,
    p_target_type: e.targetType ?? null, p_target_id: e.targetId ?? null,
    p_metadata: redact(e.metadata ?? {}), p_ip: e.ip ?? null, p_request_id: e.requestId ?? null,
  });
  if (error) throw new HttpError(500, 'internal', 'audit write failed');
}
