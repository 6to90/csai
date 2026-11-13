import 'server-only';
import { SmtpError, smtpSender, type MailSender } from '../adapters/mail';
import { secrets } from '../security/secrets-instance';
import { systemClient } from '../security/system-client';
import { NonRetryableError, type Handlers, type JobRow } from './worker';

const SMTP_FALLBACK = () => (process.env.MAIL_SMTP_URL ? smtpSender(process.env.MAIL_SMTP_URL) : null);
const isLastAttempt = (j: JobRow) => j.attempts >= j.max_attempts;

// Idempotent (at-least-once jobs): the RPC returns the existing message for a seen external id; the event row is just marked.
async function processInbound(job: JobRow) {
  const db = systemClient();
  const eventId = String(job.payload.event_id);
  const { data: ev } = await db.from('webhook_events').select('id,channel_account_id,payload,status').eq('id', eventId).eq('org_id', job.org_id).maybeSingle();
  if (!ev) throw new NonRetryableError('event not found');
  if (ev.status === 'processed' || !ev.payload) return;
  try {
    const { error } = await db.rpc('process_inbound', { p_org: job.org_id, p_channel: ev.channel_account_id, p_msg: ev.payload });
    if (error) throw error.code === 'P0002' || error.code === '22023' ? new NonRetryableError('inbound rejected') : new Error('process_inbound failed');
    await db.from('webhook_events').update({ status: 'processed' }).eq('id', eventId).eq('org_id', job.org_id);
  } catch (e) {
    if (e instanceof NonRetryableError || isLastAttempt(job)) await db.from('webhook_events').update({ status: 'failed' }).eq('id', eventId).eq('org_id', job.org_id);
    throw e;
  }
}

async function sendOutbound(job: JobRow) {
  const db = systemClient();
  const id = String(job.payload.message_id);
  const { data: m } = await db.from('messages').select('id,status,body,external_id,conversation_id,channel_account_id').eq('id', id).eq('org_id', job.org_id).maybeSingle();
  if (!m) throw new NonRetryableError('message not found');
  if (m.status === 'sent') return;                                              // already delivered by an earlier attempt
  if (m.status !== 'queued' && m.status !== 'sending') throw new NonRetryableError('message not sendable');
  await db.from('messages').update({ status: 'sending' }).eq('id', id).eq('org_id', job.org_id).in('status', ['queued', 'sending']);
  // One audited, guarded transition per outcome (only queued/sending rows can move).
  const record = async (status: 'sent' | 'failed', code: string, ref?: string) => { const { error } = await db.rpc('record_send_result', { p_org: job.org_id, p_msg: id, p_status: status, p_code: code, p_ref: ref ?? null }); if (error) throw new Error('could not record send result'); };
  try {
    const [{ data: ch }, { data: conv }] = await Promise.all([
      db.from('channel_accounts').select('address,config,integration_id').eq('id', m.channel_account_id).eq('org_id', job.org_id).single(),
      db.from('conversations').select('subject,customer_id').eq('id', m.conversation_id).eq('org_id', job.org_id).single(),
    ]);
    const { data: ident } = await db.from('customer_identities').select('value').eq('org_id', job.org_id).eq('customer_id', conv!.customer_id).eq('kind', 'email').limit(1).maybeSingle();
    if (!ident || !ch?.address) throw new SmtpError('no recipient', 'no_recipient', 'permanent');
    const smtpUrl = ch.integration_id ? await secrets().get(job.org_id, ch.integration_id, 'smtp_url') : null;
    const sender: MailSender | null = smtpUrl ? smtpSender(smtpUrl) : SMTP_FALLBACK();
    if (!sender) throw new SmtpError('no transport', 'no_transport', 'permanent');
    const { data: prior } = await db.from('messages').select('external_id').eq('org_id', job.org_id).eq('conversation_id', m.conversation_id).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const subj = conv!.subject ?? '';
    // The external id is deterministic, so any re-send of the same message carries the SAME Message-ID (receivers dedupe).
    const res = await sender.send({ to: ident.value, from: ch.address, fromName: (ch.config as { from_name?: string }).from_name, subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`, text: m.body, messageId: m.external_id ?? undefined, inReplyTo: prior?.external_id ?? undefined, references: prior?.external_id ? [prior.external_id] : undefined });
    await record('sent', '', res?.ref);
  } catch (e) {
    if (e instanceof SmtpError) {
      // permanent: retrying cannot help. uncertain: it may already be delivered => NEVER auto-retry; a human decides (manual retry reuses the same Message-ID).
      if (e.kind !== 'transient') { await record('failed', e.code); throw new NonRetryableError(e.code); }
      if (isLastAttempt(job)) { await record('failed', e.code); throw e; }
      await db.from('messages').update({ status: 'queued' }).eq('id', id).eq('org_id', job.org_id).eq('status', 'sending'); throw e;
    }
    if (isLastAttempt(job)) await record('failed', 'send_failed'); else await db.from('messages').update({ status: 'queued' }).eq('id', id).eq('org_id', job.org_id).eq('status', 'sending');
    throw e;
  }
}

export const inboxHandlers: Handlers = { process_inbound: processInbound, send_outbound: sendOutbound };
