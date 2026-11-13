-- Phase 3C-A production email. Additive: nullable columns only; existing messages/conversations are untouched.
-- Rollback: restore process_inbound/create_channel_account/audit_meta_ok from 0005, drop record_send_result, drop columns refs/delivery_ref.

alter table public.messages add column refs text[], add column delivery_ref text check (char_length(delivery_ref) <= 64);
create index messages_refs_idx on public.messages using gin (refs) where refs is not null;

create or replace function public.audit_meta_ok(p_action text, p_meta jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare allowed text[]; k text; v jsonb;
begin
  allowed := case p_action
    when 'org.create'         then array['slug']
    when 'org.update'         then array['fields']
    when 'invitation.create'  then array['role']
    when 'invitation.accept'  then array['role']
    when 'invitation.revoke'  then array[]::text[]
    when 'invitation.resend'  then array[]::text[]
    when 'member.role_change' then array['from','to']
    when 'member.remove'      then array['role']
    when 'channel.create'     then array['kind']
    when 'channel.update'     then array['status']
    when 'conversation.update' then array['fields']
    when 'email.receive'      then array[]::text[]
    when 'email.send'         then array['status','code']
    when 'job.dead'           then array['type','reason','retryable']
    when 'secrets.key_rotate' then array['version']
    else null end;
  if allowed is null or p_meta is null or jsonb_typeof(p_meta) <> 'object' then return false; end if;
  for k, v in select key, value from jsonb_each(p_meta) loop
    if not (k = any(allowed)) then return false; end if;                       -- only registered keys
    if jsonb_typeof(v) = 'string' then
      if char_length(v #>> '{}') > 64 or (v #>> '{}') !~ '^[A-Za-z0-9_.,:-]*$' then return false; end if;  -- short identifier-like tokens only: no free text, no emails
    elsif jsonb_typeof(v) not in ('number','boolean') then return false;       -- no nested objects/arrays/null
    end if;
  end loop;
  return true;
end $$;

create or replace function public.create_channel_account(p_org uuid, p_kind text, p_name text, p_address text, p_config jsonb)
returns table(out_id uuid, out_public_key text, out_integration_id uuid)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_integ uuid; v_id uuid; v_pk text; v_addr text := nullif(lower(trim(coalesce(p_address,''))), '');
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  perform public.assert_aal2_if_privileged(p_org);
  if not exists (select 1 from public.memberships where org_id = p_org and user_id = v_uid and role in ('owner','admin')) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind not in ('email','web_chat') or char_length(trim(coalesce(p_name,''))) not between 1 and 120 then raise exception 'validation_failed' using errcode = '22023'; end if;
  if p_kind = 'email' and (v_addr is null or v_addr !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'validation_failed' using errcode = '22023'; end if;
  if p_kind = 'web_chat' and (jsonb_typeof(coalesce(p_config->'allowed_origins','null'::jsonb)) <> 'array' or jsonb_array_length(p_config->'allowed_origins') not between 1 and 10) then raise exception 'validation_failed' using errcode = '22023'; end if;
  if p_kind = 'email' then   -- holds the inbound signing secret (and optional SMTP URL) in integration_secrets
    insert into public.integrations(org_id, kind, name) values (p_org, 'email_inbound', trim(p_name)) returning id into v_integ;
  end if;
  insert into public.channel_accounts(org_id, kind, name, address, config, integration_id)
  values (p_org, p_kind, trim(p_name), v_addr, case when p_kind = 'web_chat' then jsonb_build_object('allowed_origins', p_config->'allowed_origins') else coalesce(jsonb_build_object('from_name', nullif(left(regexp_replace(coalesce(p_config->>'from_name',''), '[[:cntrl:]]', ' ', 'g'), 100), '')), '{}'::jsonb) end, v_integ)
  returning id, public_key into v_id, v_pk;
  perform public.append_audit(p_org, 'user', v_uid, 'channel.create', 'channel_account', v_id::text, jsonb_build_object('kind', p_kind));
  return query select v_id, case when p_kind = 'web_chat' then v_pk else null end, v_integ;
end $$;

create or replace function public.process_inbound(p_org uuid, p_channel uuid, p_msg jsonb)
returns table(out_conv uuid, out_msg uuid, out_dup boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_ext text := p_msg->>'external_id'; v_kind text := p_msg->>'from_kind'; v_val text := lower(trim(p_msg->>'from_value'));
  v_body text := coalesce(p_msg->>'body',''); v_ch public.channel_accounts; v_cust uuid; v_conv uuid; v_mid uuid; v_thread text;
  v_refs text[]; v_reply text := nullif(p_msg->>'in_reply_to','');
begin
  select * into v_ch from public.channel_accounts where id = p_channel and org_id = p_org;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_ext is null or v_ext = '' or v_kind not in ('email','chat_visitor') or v_val is null or v_val = '' then raise exception 'validation_failed' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || p_channel::text || v_ext, 0));      -- serialises concurrent copies of the same message
  select m.conversation_id, m.id into v_conv, v_mid from public.messages m where m.org_id = p_org and m.channel_account_id = p_channel and m.direction = 'inbound' and m.external_id = v_ext;
  if found then return query select v_conv, v_mid, true; return; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org::text || v_kind || v_val, 1));
  select customer_id into v_cust from public.customer_identities where org_id = p_org and kind = v_kind and value = v_val;
  if v_cust is null then
    insert into public.customers(org_id, display_name, email) values (p_org, coalesce(nullif(trim(p_msg->>'from_name'),''), case when v_kind = 'email' then v_val else 'Visitor' end), case when v_kind = 'email' then v_val end) returning id into v_cust;
    insert into public.customer_identities(org_id, customer_id, kind, value) values (p_org, v_cust, v_kind, v_val);
  end if;

  if nullif(p_msg->>'conversation_id','') is not null then                      -- web chat: the session already owns its conversation
    select id into v_conv from public.conversations where id = (p_msg->>'conversation_id')::uuid and org_id = p_org and channel_account_id = p_channel and customer_id = v_cust;
    if v_conv is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  else
    select coalesce(array(select jsonb_array_elements_text(coalesce(p_msg->'references','[]'::jsonb))), '{}') into v_refs;
    if v_reply is not null and not (v_reply = any(v_refs)) then v_refs := array_append(v_refs, v_reply); end if;
    -- Threading never crosses customers: a mail that merely QUOTES someone else's Message-ID (ids are not secret) cannot be injected into their conversation.
    -- 1) a known parent  2) children that arrived BEFORE this message (they reference its id)  3) the thread key (first reference, or own id)
    select c.id into v_conv from public.messages m join public.conversations c on c.org_id = m.org_id and c.id = m.conversation_id
     where m.org_id = p_org and m.channel_account_id = p_channel and m.external_id = any(v_refs) and c.customer_id = v_cust order by m.created_at desc limit 1;
    if v_conv is null then
      select c.id into v_conv from public.messages m join public.conversations c on c.org_id = m.org_id and c.id = m.conversation_id
       where m.org_id = p_org and m.channel_account_id = p_channel and m.refs @> array[v_ext] and c.customer_id = v_cust order by m.created_at limit 1;
    end if;
    v_thread := coalesce(v_refs[1], v_ext);
    if v_conv is null then
      select id into v_conv from public.conversations where org_id = p_org and channel_account_id = p_channel and customer_id = v_cust and external_thread_id = any(array[v_thread, v_ext]) limit 1;
    end if;
    if v_conv is null then
      if exists (select 1 from public.conversations where org_id = p_org and channel_account_id = p_channel and external_thread_id = v_thread) then
        v_thread := v_ext || ':' || v_cust;                                      -- same thread key but another customer: separate, safe conversation
      end if;
      insert into public.conversations(org_id, channel_account_id, customer_id, subject, external_thread_id, last_message_at)
      values (p_org, p_channel, v_cust, left(nullif(trim(p_msg->>'subject'),''), 300), v_thread, now()) returning id into v_conv;
    end if;
  end if;

  insert into public.messages(org_id, channel_account_id, conversation_id, direction, sender_type, content_type, body, status, external_id, in_reply_to, refs)
  values (p_org, p_channel, v_conv, 'inbound', 'customer', coalesce(nullif(p_msg->>'content_type',''), 'text'), v_body, 'received', v_ext, v_reply, nullif(v_refs, '{}')) returning id into v_mid;
  insert into public.attachments(org_id, message_id, filename, mime, size)
  select p_org, v_mid, left(a->>'filename', 255), left(coalesce(a->>'mime','application/octet-stream'), 127), greatest(coalesce((a->>'size')::bigint, 0), 0)
    from jsonb_array_elements(coalesce(p_msg->'attachments','[]'::jsonb)) a limit 20;
  update public.conversations set last_message_at = now(), unread_count = unread_count + 1, last_message_preview = left(regexp_replace(v_body, '\s+', ' ', 'g'), 160),
         status = case when status in ('resolved','closed','waiting_customer') then 'open' else status end,
         resolved_at = case when status in ('resolved','closed') then null else resolved_at end, updated_at = now()
   where id = v_conv and org_id = p_org;
  if v_ch.kind = 'email' then perform public.append_audit(p_org, 'system', null, 'email.receive', 'message', v_mid::text); end if;
  return query select v_conv, v_mid, false;
end $$;

-- Outcome of an outbound mail attempt, with an audit row in the same transaction. Service role only. Only queued/sending messages can transition.
create function public.record_send_result(p_org uuid, p_msg uuid, p_status text, p_code text, p_ref text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_status not in ('sent','failed') or coalesce(p_code,'') !~ '^[A-Za-z0-9_.:-]{0,64}$' then raise exception 'validation_failed' using errcode = '22023'; end if;
  update public.messages set status = p_status, error_code = case when p_status = 'failed' then nullif(p_code,'') end, delivery_ref = left(p_ref, 64), sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_msg and org_id = p_org and direction = 'outbound' and status in ('queued','sending') returning id into v_id;
  if v_id is null then return false; end if;
  perform public.append_audit(p_org, 'system', null, 'email.send', 'message', v_id::text, jsonb_build_object('status', p_status, 'code', coalesce(nullif(p_code,''), 'ok')));
  return true;
end $$;
revoke all on function public.record_send_result(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_send_result(uuid, uuid, text, text, text) to service_role;
