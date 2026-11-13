-- Phase 3C-B web chat widget. Additive. Rollback: drop the new functions, restore chat_start(…6 args)/create_channel_account/audit_meta_ok from 0005/0006, drop chat_sessions.verified_email, restore the integrations kind check.

do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.integrations'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%email_smtp%';
  if c is not null then execute format('alter table public.integrations drop constraint %I', c); end if;
end $$;
alter table public.integrations add constraint integrations_kind_check check (kind in ('email_smtp','email_inbound','http_connector','llm_byok','voice','web_chat'));
alter table public.chat_sessions add column verified_email text check (verified_email = lower(verified_email) and char_length(verified_email) <= 254);

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
    when 'channel.update'     then array['status','fields']
    when 'channel.secret'     then array[]::text[]
    when 'chat.revoke'        then array[]::text[]
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

-- Widget config validation shared by create/update: origins (https/http origin only), cosmetic text, colour.
create function public.widget_config_ok(p jsonb) returns boolean language sql immutable set search_path = public as $$
  select jsonb_typeof(p->'allowed_origins') = 'array' and jsonb_array_length(p->'allowed_origins') between 1 and 10
     and not exists (select 1 from jsonb_array_elements(p->'allowed_origins') o where jsonb_typeof(o) <> 'string' or (o #>> '{}') !~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$')
     and coalesce(char_length(p->>'title'), 0) <= 40 and coalesce(char_length(p->>'greeting'), 0) <= 200
     and coalesce(p->>'color', '#6E8BFF') ~ '^#[0-9A-Fa-f]{6}$' $$;

create or replace function public.create_channel_account(p_org uuid, p_kind text, p_name text, p_address text, p_config jsonb)
returns table(out_id uuid, out_public_key text, out_integration_id uuid)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_integ uuid; v_id uuid; v_pk text; v_addr text := nullif(lower(trim(coalesce(p_address,''))), ''); v_cfg jsonb;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  perform public.assert_aal2_if_privileged(p_org);
  if not exists (select 1 from public.memberships where org_id = p_org and user_id = v_uid and role in ('owner','admin')) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind not in ('email','web_chat') or char_length(trim(coalesce(p_name,''))) not between 1 and 120 then raise exception 'validation_failed' using errcode = '22023'; end if;
  if p_kind = 'email' then
    if v_addr is null or v_addr !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'validation_failed' using errcode = '22023'; end if;
    insert into public.integrations(org_id, kind, name) values (p_org, 'email_inbound', trim(p_name)) returning id into v_integ;   -- inbound signing secret (+ optional SMTP URL)
    v_cfg := coalesce(jsonb_build_object('from_name', nullif(left(regexp_replace(coalesce(p_config->>'from_name',''), '[[:cntrl:]]', ' ', 'g'), 100), '')), '{}'::jsonb);
  else
    if not public.widget_config_ok(p_config) then raise exception 'validation_failed' using errcode = '22023'; end if;
    insert into public.integrations(org_id, kind, name) values (p_org, 'web_chat', trim(p_name)) returning id into v_integ;      -- visitor identity-verification secret
    v_cfg := jsonb_strip_nulls(jsonb_build_object('allowed_origins', p_config->'allowed_origins', 'title', p_config->'title', 'greeting', p_config->'greeting', 'color', p_config->'color'));
  end if;
  insert into public.channel_accounts(org_id, kind, name, address, config, integration_id) values (p_org, p_kind, trim(p_name), v_addr, v_cfg, v_integ) returning id, public_key into v_id, v_pk;
  perform public.append_audit(p_org, 'user', v_uid, 'channel.create', 'channel_account', v_id::text, jsonb_build_object('kind', p_kind));
  return query select v_id, case when p_kind = 'web_chat' then v_pk else null end, v_integ;
end $$;

-- Widget settings (name, origins, cosmetics). Removing an origin takes effect on existing sessions at their next request.
create function public.update_widget(p_id uuid, p_name text, p_config jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_ch public.channel_accounts; v_new jsonb;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_ch from public.channel_accounts where id = p_id and kind = 'web_chat';
  if not found or not exists (select 1 from public.memberships where org_id = v_ch.org_id and user_id = v_uid) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.assert_aal2_if_privileged(v_ch.org_id);
  if not exists (select 1 from public.memberships where org_id = v_ch.org_id and user_id = v_uid and role in ('owner','admin')) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_new := jsonb_strip_nulls(v_ch.config || coalesce(p_config, '{}'::jsonb));
  if not public.widget_config_ok(v_new) or (p_name is not null and char_length(trim(p_name)) not between 1 and 120) then raise exception 'validation_failed' using errcode = '22023'; end if;
  update public.channel_accounts set config = v_new, name = coalesce(trim(p_name), name), updated_at = now() where id = p_id and org_id = v_ch.org_id;
  perform public.append_audit(v_ch.org_id, 'user', v_uid, 'channel.update', 'channel_account', p_id::text, jsonb_build_object('fields', 'widget'));
end $$;

-- Identity-verification secret: creates the integration for widgets that predate it, and audits the (re)issue. The route stores the new secret value.
create function public.prepare_widget_secret(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_ch public.channel_accounts; v_integ uuid;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_ch from public.channel_accounts where id = p_id and kind = 'web_chat';
  if not found or not exists (select 1 from public.memberships where org_id = v_ch.org_id and user_id = v_uid) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.assert_aal2_if_privileged(v_ch.org_id);
  if not exists (select 1 from public.memberships where org_id = v_ch.org_id and user_id = v_uid and role in ('owner','admin')) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_integ := v_ch.integration_id;
  if v_integ is null then
    insert into public.integrations(org_id, kind, name) values (v_ch.org_id, 'web_chat', v_ch.name) returning id into v_integ;
    update public.channel_accounts set integration_id = v_integ where id = p_id and org_id = v_ch.org_id;
  end if;
  perform public.append_audit(v_ch.org_id, 'user', v_uid, 'channel.secret', 'channel_account', p_id::text);
  return v_integ;
end $$;

drop function public.chat_start(text, text, text, text, bytea, text);
create function public.chat_start(p_public_key text, p_origin text, p_visitor text, p_name text, p_token_hash bytea, p_ip_hash text, p_email text default null)
returns table(out_org uuid, out_channel uuid, out_conv uuid, out_session uuid)
language plpgsql security definer set search_path = public as $$
declare v_ch public.channel_accounts; v_cust uuid; v_conv uuid; v_sid uuid := gen_random_uuid(); v_vis text := lower(trim(p_visitor)); v_mail text := nullif(lower(trim(coalesce(p_email,''))), '');
begin
  select * into v_ch from public.channel_accounts where public_key = p_public_key and kind = 'web_chat' and status = 'active';
  if not found or p_origin is null or not (v_ch.config->'allowed_origins') ? p_origin then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_vis is null or v_vis !~ '^[a-z0-9_-]{8,64}$' then raise exception 'validation_failed' using errcode = '22023'; end if;
  if v_mail is not null and v_mail !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'validation_failed' using errcode = '22023'; end if;
  -- A verified e-mail (the route checked the customer's HMAC) joins the same customer as their e-mail conversations; otherwise the unverified visitor id is used.
  perform pg_advisory_xact_lock(hashtextextended(v_ch.org_id::text || case when v_mail is null then 'chat_visitor' || v_vis else 'email' || v_mail end, 1));
  select customer_id into v_cust from public.customer_identities where org_id = v_ch.org_id and kind = case when v_mail is null then 'chat_visitor' else 'email' end and value = coalesce(v_mail, v_vis);
  if v_cust is null then
    insert into public.customers(org_id, display_name, email) values (v_ch.org_id, coalesce(nullif(left(regexp_replace(trim(coalesce(p_name,'')), '[[:cntrl:]]', ' ', 'g'), 120), ''), case when v_mail is null then 'Visitor' else v_mail end), v_mail) returning id into v_cust;
    insert into public.customer_identities(org_id, customer_id, kind, value) values (v_ch.org_id, v_cust, case when v_mail is null then 'chat_visitor' else 'email' end, coalesce(v_mail, v_vis));
  end if;
  insert into public.conversations(org_id, channel_account_id, customer_id, external_thread_id) values (v_ch.org_id, v_ch.id, v_cust, 'chat:' || v_sid) returning id into v_conv;
  insert into public.chat_sessions(id, org_id, channel_account_id, conversation_id, visitor_id, token_hash, ip_hash, origin, verified_email) values (v_sid, v_ch.org_id, v_ch.id, v_conv, v_vis, p_token_hash, p_ip_hash, p_origin, v_mail);
  return query select v_ch.org_id, v_ch.id, v_conv, v_sid;
end $$;

-- Agent ends a chat: every session of the conversation is revoked (visitor tokens die at once) and the conversation is closed. Audited.
create function public.end_chat(p_conv uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_c public.conversations; v_n int;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_c from public.conversations where id = p_conv for update;
  if not found or not exists (select 1 from public.memberships where org_id = v_c.org_id and user_id = v_uid) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.assert_aal2_if_privileged(v_c.org_id);
  if not exists (select 1 from public.memberships where org_id = v_c.org_id and user_id = v_uid and role in ('owner','admin','agent')) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.chat_sessions set revoked_at = now() where org_id = v_c.org_id and conversation_id = p_conv and revoked_at is null;
  get diagnostics v_n = row_count;
  update public.conversations set status = 'closed', resolved_at = coalesce(resolved_at, now()), updated_at = now() where id = p_conv and org_id = v_c.org_id;
  perform public.append_audit(v_c.org_id, 'user', v_uid, 'chat.revoke', 'conversation', p_conv::text);
  return v_n;
end $$;

revoke all on function public.widget_config_ok(jsonb), public.update_widget(uuid,text,jsonb), public.prepare_widget_secret(uuid), public.chat_start(text,text,text,text,bytea,text,text), public.end_chat(uuid) from public, anon, authenticated;
grant execute on function public.update_widget(uuid,text,jsonb), public.prepare_widget_secret(uuid), public.end_chat(uuid) to authenticated;
grant execute on function public.chat_start(text,text,text,text,bytea,text,text) to service_role;
