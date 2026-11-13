import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendInvitationMail } from './adapters/mail';

export const acceptUrl = (token: string) => `${process.env.APP_URL ?? ''}/invite?token=${encodeURIComponent(token)}`;

/** Mails the link when a transport is configured; otherwise (or on mail failure) returns it once in the API response so an admin can copy it. */
export async function deliverInvitation(db: SupabaseClient, orgId: string, email: string, token: string, expiresAt: string) {
  const { data } = await db.from('organizations').select('name').eq('id', orgId).single();
  const url = acceptUrl(token);
  const mailed = await sendInvitationMail(email, data?.name ?? 'CSAI', url, expiresAt);
  return mailed ? { mail_sent: true as const } : { mail_sent: false as const, accept_url: url };
}
