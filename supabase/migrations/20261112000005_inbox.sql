-- Phase 3B unified inbox: customer_identities, messages, attachments + service/RPC write paths. Additive.
-- Rollback: drop the functions and the three tables; drop conversations columns priority/unread_count/last_message_preview; restore audit_meta_ok from 0002.

alter table public.conversations
  add column priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  add column unread_count int not null default 0 check (unread_count >= 0),
  add column last_message_preview text check (char_length(last_message_preview) <= 160);
create index conversations_assignee_idx on public.conversations(org_id, assignee_id, status);

create table public.customer_identities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null,
  kind text not null check (kind in ('email','phone','chat_visitor')),
  value text not null check (value = lower(value) and char_length(value) <= 320),
  created_at timestamptz not null default now(),
  unique (org_id, kind, value),
  foreign key (org_id, customer_id) references public.customers(org_id, id) on delete cascade
);
create index customer_identities_customer_idx on public.customer_identities(org_id, customer_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel_account_id uuid not null,
  conversation_id uuid not null,
  direction text not null check (direction in ('inbound','outbound','internal')),
  sender_type text not null check (sender_type in ('customer','agent','ai','system')),
  sender_id uuid references auth.users(id),
  content_type text not null default 'text' check (content_type in ('text','html','transcript')),
  body text not null check (char_length(body) <= 200000),
  status text not null check (status in ('received','draft','queued','sending','sent','failed')),
  external_id text check (char_length(external_id) <= 998),
  in_reply_to text,
  send_attempt int not null default 0,
  error_code text check (char_length(error_code) <= 64),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, conversation_id) references public.conversations(org_id, id) on delete cascade,
  foreign key (org_id, channel_account_id) references public.channel_accounts(org_id, id)
);
create unique index messages_dedupe on public.messages(org_id, channel_account_id, direction, external_id) where external_id is not null;
create index messages_conv_idx on public.messages(org_id, conversation_id, created_at);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  message_id uuid not null,
  filename text not null check (char_length(filename) <= 255),
  mime text not null check (char_length(mime) <= 127),
  size bigint not null check (size >= 0),
  storage_path text,                                   -- null until the file bytes are stored (metadata-only in 3B)
  scan_status text not null default 'pending' check (scan_status in ('pending','clean','infected','skipped')),
  created_at timestamptz not null default now(),
  foreign key (org_id, message_id) references public.messages(org_id, id) on delete cascade
);

alter table public.customer_identities enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;
alter table public.customer_identities force row level security;
alter table public.messages force row level security;
alter table public.attachments force row level security;
create policy identities_select on public.customer_identities for select using (public.is_member(org_id));
create policy messages_select on public.messages for select using (public.is_member(org_id));
create policy attachments_select on public.attachments for select using (public.is_member(org_id));
-- No INSERT/UPDATE/DELETE policies or grants on messages/identities/attachments: all writes go through the RPCs below or the service role.
grant select on public.customer_identities, public.messages, public.attachments to authenticated;
grant all on public.customer_identities, public.messages, public.attachments to service_role;
alter publication supabase_realtime add table public.conversations, public.messages;   -- Realtime honours RLS with the user's JWT

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

-- ===== channel accounts (admin + aal2, audited) =====
create function public.create_channel_account(p_org uuid, p_kind text, p_name text, p_address text, p_config jsonb)
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
  values (p_org, p_kind, trim(p_name), v_addr, case when p_kind = 'web_chat' then jsonb_build_object('allowed_origins', p_config->'allowed_origins') else '{}'::jsonb end, v_integ)
  returning id, public_key into v_id, v_pk;
  perform public.append_audit(p_org, 'user', v_uid, 'channel.create', 'channel_account', v_id::text, jsonb_build_object('kind', p_kind));
  return query select v_id, case when p_kind = 'web_chat' then v_pk else null end, v_integ;
end $$;

create function public.set_channel_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_org uuid;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select org_id into v_org from public.channel_accounts where id = p_id;
  if v_org is null or not exists (select 1 from public.memberships where org_id = v_org and user_id = v_uid) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.assert_aal2_if_privileged(v_org);
  if not exists (select 1 from public.memberships where org_id = v_org and user_id = v_uid and role in ('owner','admin')) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('active','paused') then raise exception 'validation_failed' using errcode = '22023'; end if;
  update public.channel_accounts set status = p_status, updated_at = now() where id = p_id and org_id = v_org;
  perform public.append_audit(v_org, 'user', v_uid, 'channel.update', 'channel_account', p_id::text, jsonb_build_object('status', p_status));
end $$;

-- ===== inbound (service role only) =====
create function public.receive_webhook(p_org uuid, p_channel uuid, p_provider text, p_event_id text, p_payload jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.channel_accounts where id = p_channel and org_id = p_org and status = 'active') then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.webhook_events(org_id, channel_account_id, provider, external_event_id, payload) values (p_org, p_channel, p_provider, p_event_id, p_payload)
  on conflict (org_id, channel_account_id, external_event_id) do nothing returning id into v_id;
  if v_id is null then return false; end if;                                  -- replay / duplicate: nothing else happens
  perform public.enqueue_job(p_org, 'process_inbound', jsonb_build_object('event_id', v_id), v_id::text);
  return true;
end $$;

-- One transaction: identify customer -> thread -> conversation -> message. A duplicate returns early BEFORE creating anything (no orphan conversation).
create function public.process_inbound(p_org uuid, p_channel uuid, p_msg jsonb)
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
    if v_reply is not null then v_refs := v_refs || v_reply; end if;
    select m.conversation_id into v_conv from public.messages m
     where m.org_id = p_org and m.channel_account_id = p_channel and m.external_id = any(v_refs) order by m.created_at desc limit 1;   -- threading by Message-ID
    if v_conv is null then
      v_thread := coalesce(v_refs[1], v_ext);
      select id into v_conv from public.conversations where org_id = p_org and channel_account_id = p_channel and external_thread_id = v_thread;
    end if;
    if v_conv is null then
      insert into public.conversations(org_id, channel_account_id, customer_id, subject, external_thread_id, last_message_at)
      values (p_org, p_channel, v_cust, left(nullif(trim(p_msg->>'subject'),''), 300), v_thread, now()) returning id into v_conv;
    end if;
  end if;

  insert into public.messages(org_id, channel_account_id, conversation_id, direction, sender_type, content_type, body, status, external_id, in_reply_to)
  values (p_org, p_channel, v_conv, 'inbound', 'customer', coalesce(nullif(p_msg->>'content_type',''), 'text'), v_body, 'received', v_ext, v_reply) returning id into v_mid;
  insert into public.attachments(org_id, message_id, filename, mime, size)
  select p_org, v_mid, left(a->>'filename', 255), left(coalesce(a->>'mime','application/octet-stream'), 127), greatest(coalesce((a->>'size')::bigint, 0), 0)
    from jsonb_array_elements(coalesce(p_msg->'attachments','[]'::jsonb)) a limit 20;
  update public.conversations set last_message_at = now(), unread_count = unread_count + 1, last_message_preview = left(regexp_replace(v_body, '\s+', ' ', 'g'), 160),
         status = case when status in ('resolved','closed','waiting_customer') then 'open' else status end,
         resolved_at = case when status in ('resolved','closed') then null else resolved_at end, updated_at = now()
   where id = v_conv and org_id = p_org;
  return query select v_conv, v_mid, false;
end $$;

-- ===== web chat session (service role only; the route has already hashed the token) =====
create function public.chat_start(p_public_key text, p_origin text, p_visitor text, p_name text, p_token_hash bytea, p_ip_hash text)
returns table(out_org uuid, out_channel uuid, out_conv uuid, out_session uuid)
language plpgsql security definer set search_path = public as $$
declare v_ch public.channel_accounts; v_cust uuid; v_conv uuid; v_sid uuid := gen_random_uuid(); v_vis text := lower(trim(p_visitor));
begin
  select * into v_ch from public.channel_accounts where public_key = p_public_key and kind = 'web_chat' and status = 'active';
  if not found or p_origin is null or not (v_ch.config->'allowed_origins') ? p_origin then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_vis is null or v_vis !~ '^[a-z0-9_-]{8,64}$' then raise exception 'validation_failed' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_ch.org_id::text || 'chat_visitor' || v_vis, 1));
  select customer_id into v_cust from public.customer_identities where org_id = v_ch.org_id and kind = 'chat_visitor' and value = v_vis;
  if v_cust is null then
    insert into public.customers(org_id, display_name) values (v_ch.org_id, coalesce(nullif(left(trim(p_name), 120), ''), 'Visitor')) returning id into v_cust;
    insert into public.customer_identities(org_id, customer_id, kind, value) values (v_ch.org_id, v_cust, 'chat_visitor', v_vis);
  end if;
  insert into public.conversations(org_id, channel_account_id, customer_id, external_thread_id) values (v_ch.org_id, v_ch.id, v_cust, 'chat:' || v_sid) returning id into v_conv;
  insert into public.chat_sessions(id, org_id, channel_account_id, conversation_id, visitor_id, token_hash, ip_hash, origin) values (v_sid, v_ch.org_id, v_ch.id, v_conv, v_vis, p_token_hash, p_ip_hash, p_origin);
  return query select v_ch.org_id, v_ch.id, v_conv, v_sid;
end $$;

-- ===== agent actions (authenticated; owner/admin need aal2) =====
create function public.send_reply(p_conv uuid, p_body text, p_client_id uuid, p_internal boolean default false)
returns table(out_msg uuid, out_status text, out_dup boolean)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_c public.conversations; v_ch public.channel_accounts; v_ext text; v_dir text; v_st text; v_mid uuid; v_to text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_c from public.conversations where id = p_conv;
  if not found or not exists (select 1 from public.memberships where org_id = v_c.org_id and user_id = v_uid) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.assert_aal2_if_privileged(v_c.org_id);
  if not exists (select 1 from public.memberships where org_id = v_c.org_id and user_id = v_uid and role in ('owner','admin','agent')) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_client_id is null or char_length(trim(coalesce(p_body,''))) not between 1 and 20000 then raise exception 'validation_failed' using errcode = '22023'; end if;
  select * into v_ch from public.channel_accounts where id = v_c.channel_account_id and org_id = v_c.org_id;
  v_dir := case when p_internal then 'internal' else 'outbound' end;
  v_ext := lower(p_client_id::text) || '@csai.local';
  perform pg_advisory_xact_lock(hashtextextended(v_c.org_id::text || v_ext, 2));
  select id, status into v_mid, v_st from public.messages where org_id = v_c.org_id and channel_account_id = v_c.channel_account_id and direction = v_dir and external_id = v_ext;
  if found then return query select v_mid, v_st, true; return; end if;      -- double click / retry of the same compose
  if not p_internal and v_ch.kind = 'email' then
    select ci.value into v_to from public.customer_identities ci where ci.org_id = v_c.org_id and ci.customer_id = v_c.customer_id and ci.kind = 'email' limit 1;
    if v_to is null then raise exception 'validation_failed' using errcode = '22023'; end if;
  end if;
  v_st := case when p_internal or v_ch.kind = 'web_chat' then 'sent' else 'queued' end;
  insert into public.messages(org_id, channel_account_id, conversation_id, direction, sender_type, sender_id, body, status, external_id, sent_at)
  values (v_c.org_id, v_c.channel_account_id, v_c.id, v_dir, 'agent', v_uid, trim(p_body), v_st, v_ext, case when v_st = 'sent' then now() end) returning id into v_mid;
  if v_st = 'queued' then perform public.enqueue_job(v_c.org_id, 'send_outbound', jsonb_build_object('message_id', v_mid), v_mid::text || ':0'); end if;
  if not p_internal then
    update public.conversations set last_message_at = now(), unread_count = 0, first_response_at = coalesce(first_response_at, now()),
           assignee_id = coalesce(assignee_id, v_uid), status = case when status = 'open' then 'waiting_customer' else status end,
           last_message_preview = left(regexp_replace(trim(p_body), '\s+', ' ', 'g'), 160), updated_at = now() where id = v_c.id;
  end if;
  return query select v_mid, v_st, false;
end $$;

create function public.retry_message(p_msg uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_m public.messages; v_n int;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_m from public.messages where id = p_msg;
  if not found or not exists (select 1 from public.memberships where org_id = v_m.org_id and user_id = v_uid) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.assert_aal2_if_privileged(v_m.org_id);
  if not exists (select 1 from public.memberships where org_id = v_m.org_id and user_id = v_uid and role in ('owner','admin','agent')) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.messages set status = 'queued', send_attempt = send_attempt + 1, error_code = null where id = p_msg and org_id = v_m.org_id and direction = 'outbound' and status = 'failed' returning send_attempt into v_n;
  if v_n is null then raise exception 'conflict' using errcode = '23505'; end if;
  perform public.enqueue_job(v_m.org_id, 'send_outbound', jsonb_build_object('message_id', p_msg), p_msg::text || ':' || v_n);
end $$;

create function public.update_conversation(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_c public.conversations; v_assignee uuid; v_fields text[] := '{}';
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_c from public.conversations where id = p_id for update;
  if not found or not exists (select 1 from public.memberships where org_id = v_c.org_id and user_id = v_uid) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.assert_aal2_if_privileged(v_c.org_id);
  if not exists (select 1 from public.memberships where org_id = v_c.org_id and user_id = v_uid and role in ('owner','admin','agent')) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_patch ? 'status' then
    if p_patch->>'status' not in ('open','pending_approval','waiting_customer','resolved','closed') then raise exception 'validation_failed' using errcode = '22023'; end if;
    update public.conversations set status = p_patch->>'status', resolved_at = case when p_patch->>'status' in ('resolved','closed') then coalesce(resolved_at, now()) else null end, updated_at = now() where id = p_id;
    v_fields := array_append(v_fields, 'status');
  end if;
  if p_patch ? 'priority' then
    if p_patch->>'priority' not in ('low','normal','high','urgent') then raise exception 'validation_failed' using errcode = '22023'; end if;
    update public.conversations set priority = p_patch->>'priority', updated_at = now() where id = p_id; v_fields := array_append(v_fields, 'priority');
  end if;
  if p_patch ? 'assignee_id' then
    v_assignee := nullif(p_patch->>'assignee_id','')::uuid;
    if v_assignee is not null and not exists (select 1 from public.memberships where org_id = v_c.org_id and user_id = v_assignee and role in ('owner','admin','agent')) then raise exception 'validation_failed' using errcode = '22023'; end if;
    update public.conversations set assignee_id = v_assignee, updated_at = now() where id = p_id; v_fields := array_append(v_fields, 'assignee');
  end if;
  if array_length(v_fields, 1) is null then raise exception 'validation_failed' using errcode = '22023'; end if;
  perform public.append_audit(v_c.org_id, 'user', v_uid, 'conversation.update', 'conversation', p_id::text, jsonb_build_object('fields', array_to_string(v_fields, ',')));
end $$;

create function public.mark_conversation_read(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  update public.conversations c set unread_count = 0 where c.id = p_id and exists (select 1 from public.memberships m where m.org_id = c.org_id and m.user_id = auth.uid() and m.role in ('owner','admin','agent'));
end $$;

revoke all on function public.create_channel_account(uuid,text,text,text,jsonb), public.set_channel_status(uuid,text), public.receive_webhook(uuid,uuid,text,text,jsonb),
  public.process_inbound(uuid,uuid,jsonb), public.chat_start(text,text,text,text,bytea,text), public.send_reply(uuid,text,uuid,boolean), public.retry_message(uuid),
  public.update_conversation(uuid,jsonb), public.mark_conversation_read(uuid) from public, anon, authenticated;
grant execute on function public.create_channel_account(uuid,text,text,text,jsonb), public.set_channel_status(uuid,text), public.send_reply(uuid,text,uuid,boolean), public.retry_message(uuid),
  public.update_conversation(uuid,jsonb), public.mark_conversation_read(uuid) to authenticated;
grant execute on function public.receive_webhook(uuid,uuid,text,text,jsonb), public.process_inbound(uuid,uuid,jsonb), public.chat_start(text,text,text,text,bytea,text) to service_role;
