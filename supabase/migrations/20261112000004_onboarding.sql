-- Phase 3A onboarding. Additive. 1) operator-issued (system) owner invitations 2) token preview for the public invite page 3) member list with e-mails for admins.
-- Rollback: drop the three functions; restore invitations.role check (admin,agent,viewer) and invited_by NOT NULL (only if no owner/system invitations exist).

do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.invitations'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''viewer''%' and pg_get_constraintdef(oid) like '%role%';
  if c is not null then execute format('alter table public.invitations drop constraint %I', c); end if;
end $$;
alter table public.invitations add constraint invitations_role_check check (role in ('owner','admin','agent','viewer'));
alter table public.invitations alter column invited_by drop not null;   -- null = issued by the platform operator (system)

-- Users can still only invite admin/agent/viewer (create_invitation unchanged); 'owner' is reachable only through provision_customer below.

create function public.provision_customer(p_email text, p_org_name text, p_slug text)
returns table(out_org uuid, out_inv uuid, out_token text, out_expires timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); v_slug text := lower(trim(p_slug)); v_org uuid; v_inv uuid; v_token text; v_exp timestamptz;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'validation_failed' using errcode = '22023'; end if;
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=' || E'\n', '-_');
  select id into v_org from public.organizations where slug = v_slug for update;
  if v_org is null then
    insert into public.organizations(name, slug) values (trim(p_org_name), v_slug) returning id into v_org;
    perform public.append_audit(v_org, 'system', null, 'org.create', 'organization', v_org::text, jsonb_build_object('slug', v_slug));
  elsif exists (select 1 from public.memberships where org_id = v_org) then
    raise exception 'conflict' using errcode = '23505';                       -- an adopted org is never touched
  end if;
  -- retry-safe: the same operator call again re-issues the owner invitation (old token dies); a different e-mail for an unclaimed org is refused
  select id into v_inv from public.invitations where org_id = v_org and role = 'owner' and status in ('pending','expired') and email = v_email for update;
  if v_inv is null then
    if exists (select 1 from public.invitations where org_id = v_org and status = 'pending') then raise exception 'conflict' using errcode = '23505'; end if;
    insert into public.invitations(org_id, email, role, token_hash, invited_by) values (v_org, v_email, 'owner', sha256(convert_to(v_token, 'UTF8')), null) returning id, expires_at into v_inv, v_exp;
    perform public.append_audit(v_org, 'system', null, 'invitation.create', 'invitation', v_inv::text, jsonb_build_object('role', 'owner'));
  else
    update public.invitations set status = 'pending', token_hash = sha256(convert_to(v_token, 'UTF8')), expires_at = now() + interval '7 days' where id = v_inv returning expires_at into v_exp;
    perform public.append_audit(v_org, 'system', null, 'invitation.resend', 'invitation', v_inv::text);
  end if;
  return query select v_org, v_inv, v_token, v_exp;
end $$;

-- Public invite page: describes a still-valid invitation to whoever holds the token. Bad/used/expired/revoked => no row (caller answers one uniform 404).
create function public.invitation_preview(p_token text)
returns table(out_org_name text, out_email text, out_role text, out_has_account boolean, out_expires timestamptz)
language sql stable security definer set search_path = public as $$
  select o.name, i.email, i.role, exists (select 1 from auth.users u where lower(u.email) = i.email), i.expires_at
    from public.invitations i join public.organizations o on o.id = i.org_id
   where i.token_hash = sha256(convert_to(p_token, 'UTF8')) and i.status = 'pending' and i.expires_at > now() $$;

create function public.list_members(p_org uuid)
returns table(out_id uuid, out_user_id uuid, out_email text, out_role text, out_created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_role text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select role into v_role from public.memberships where org_id = p_org and user_id = v_uid;
  if v_role is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_role in ('owner','admin') then
    perform public.assert_aal2_if_privileged(p_org);
    return query select m.id, m.user_id, u.email::text, m.role, m.created_at from public.memberships m join auth.users u on u.id = m.user_id where m.org_id = p_org order by m.created_at;
    return;                                                                   -- RETURN QUERY does not exit
  end if;
  return query select m.id, m.user_id, u.email::text, m.role, m.created_at from public.memberships m join auth.users u on u.id = m.user_id where m.org_id = p_org and m.user_id = v_uid;
end $$;

revoke all on function public.provision_customer(text, text, text), public.invitation_preview(text) from public, anon, authenticated;
grant execute on function public.provision_customer(text, text, text), public.invitation_preview(text) to service_role;
revoke all on function public.list_members(uuid) from public, anon;
grant execute on function public.list_members(uuid) to authenticated;
