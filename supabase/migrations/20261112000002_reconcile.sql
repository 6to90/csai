-- Phase 2B reconciliation (additive; 0001 is left untouched).
-- 1) audit metadata: allowlist per action instead of a forbidden-key regex
-- 2) config changes only through audited RPCs: no direct UPDATE/DELETE on organizations, no direct writes on integrations/channel_accounts

create function public.audit_meta_ok(p_action text, p_meta jsonb) returns boolean
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

create or replace function public.append_audit(
  p_org uuid, p_actor_type text, p_actor_id uuid, p_action text, p_target_type text, p_target_id text,
  p_metadata jsonb default '{}', p_ip inet default null, p_request_id text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if not public.audit_meta_ok(p_action, coalesce(p_metadata, '{}'::jsonb)) then
    raise exception 'audit metadata not allowed for action' using errcode = '22023';
  end if;
  insert into public.audit_logs(org_id, actor_type, actor_id, action, target_type, target_id, metadata, ip, request_id)
  values (p_org, p_actor_type, p_actor_id, p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'), p_ip, p_request_id)
  returning id into v;
  return v;
end $$;

-- organizations: settings change only via audited RPC; deletion deferred (cascade into append-only audit_logs would fail anyway)
drop policy org_update on public.organizations;
drop policy org_delete on public.organizations;
revoke update, delete on public.organizations from authenticated;

create function public.update_organization(p_org uuid, p_name text default null, p_retention_days int default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_caller text; v_fields text[] := '{}';
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select role into v_caller from public.memberships where org_id = p_org and user_id = v_uid;
  if v_caller is null or v_caller not in ('owner','admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_name is null and p_retention_days is null then raise exception 'validation_failed' using errcode = '22023'; end if;
  if p_name is not null then v_fields := array_append(v_fields, 'name'); end if;
  if p_retention_days is not null then v_fields := array_append(v_fields, 'data_retention_days'); end if;
  update public.organizations set name = coalesce(trim(p_name), name), data_retention_days = coalesce(p_retention_days, data_retention_days) where id = p_org;
  perform public.append_audit(p_org, 'user', v_uid, 'org.update', 'organization', p_org::text, jsonb_build_object('fields', array_to_string(v_fields, ',')));
end $$;

-- integrations / channel_accounts: read-only for users until Phase 3 adds audited RPCs
drop policy integrations_all on public.integrations;
drop policy channels_all on public.channel_accounts;
create policy integrations_select on public.integrations for select using (public.has_role(org_id, array['owner','admin']));
create policy channels_select on public.channel_accounts for select using (public.has_role(org_id, array['owner','admin']));
revoke insert, update, delete on public.integrations, public.channel_accounts from authenticated;

-- function privileges for the new functions (default-deny, explicit grant)
revoke all on function public.audit_meta_ok(text, jsonb) from public, anon, authenticated;
revoke all on function public.update_organization(uuid, text, int) from public, anon, authenticated;
grant execute on function public.audit_meta_ok(text, jsonb) to service_role;
grant execute on function public.update_organization(uuid, text, int) to authenticated, service_role;
