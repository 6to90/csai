-- Phase 2C: MFA (aal2) for privileged roles. Additive migration: existing objects are replaced in place (same signatures/grants), no table changes.
-- Rule: a member whose role is owner/admin only exercises that role with an aal2 session (TOTP verified in GoTrue).
-- Users with agent/viewer roles are unaffected; sign-in and org creation need no aal2.

create function public.is_aal2() returns boolean language sql stable set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

-- Raises mfa_required when the caller is owner/admin of p_org without an aal2 session. No-op for other roles / non-members.
create function public.assert_aal2_if_privileged(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner','admin'))
     and not public.is_aal2() then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
end $$;

-- RLS: owner/admin privileges (admin reads such as audit_logs/invitations/all memberships) require aal2.
create or replace function public.has_role(p_org uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.role = any(p_roles)
      and (m.role not in ('owner','admin') or public.is_aal2())) $$;

create or replace function public.create_invitation(p_org uuid, p_email text, p_role text)
returns table(inv_id uuid, inv_token text, inv_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_caller text; v_email text := lower(trim(p_email)); v_token text; v_id uuid; v_exp timestamptz;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select role into v_caller from public.memberships where org_id = p_org and user_id = v_uid;
  perform public.assert_aal2_if_privileged(p_org);
  if v_caller is null or v_caller not in ('owner','admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_role not in ('admin','agent','viewer') then raise exception 'validation_failed' using errcode = '22023'; end if;
  if v_caller = 'admin' and p_role = 'admin' then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'validation_failed' using errcode = '22023'; end if;
  if exists (select 1 from public.memberships m join auth.users u on u.id = m.user_id where m.org_id = p_org and lower(u.email) = v_email) then
    raise exception 'conflict' using errcode = '23505';
  end if;
  update public.invitations set status = 'expired' where org_id = p_org and email = v_email and status = 'pending' and expires_at <= now();
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=' || E'\n', '-_');
  insert into public.invitations(org_id, email, role, token_hash, invited_by)
  values (p_org, v_email, p_role, sha256(convert_to(v_token, 'UTF8')), v_uid)
  returning invitations.id, invitations.expires_at into v_id, v_exp;
  perform public.append_audit(p_org, 'user', v_uid, 'invitation.create', 'invitation', v_id::text, jsonb_build_object('role', p_role));
  return query select v_id, v_token, v_exp;
end $$;
create or replace function public.revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_inv public.invitations; v_caller text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_inv from public.invitations where id = p_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select role into v_caller from public.memberships where org_id = v_inv.org_id and user_id = v_uid;
  perform public.assert_aal2_if_privileged(v_inv.org_id);
  if v_caller is null or v_caller not in ('owner','admin') or (v_inv.role = 'admin' and v_caller <> 'owner') then
    raise exception 'forbidden' using errcode = '42501'; end if;
  update public.invitations set status = 'revoked', revoked_at = now() where id = p_id and status = 'pending';
  if not found then raise exception 'conflict' using errcode = '23505'; end if;
  perform public.append_audit(v_inv.org_id, 'user', v_uid, 'invitation.revoke', 'invitation', p_id::text);
end $$;
create or replace function public.resend_invitation(p_id uuid) returns table(inv_token text, inv_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_inv public.invitations; v_caller text; v_token text; v_exp timestamptz;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_inv from public.invitations where id = p_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select role into v_caller from public.memberships where org_id = v_inv.org_id and user_id = v_uid;
  perform public.assert_aal2_if_privileged(v_inv.org_id);
  if v_caller is null or v_caller not in ('owner','admin') or (v_inv.role = 'admin' and v_caller <> 'owner') then
    raise exception 'forbidden' using errcode = '42501'; end if;
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=' || E'\n', '-_');
  update public.invitations set token_hash = sha256(convert_to(v_token, 'UTF8')), expires_at = now() + interval '7 days'
   where id = p_id and status = 'pending' returning invitations.expires_at into v_exp;
  if not found then raise exception 'conflict' using errcode = '23505'; end if;
  perform public.append_audit(v_inv.org_id, 'user', v_uid, 'invitation.resend', 'invitation', p_id::text);
  return query select v_token, v_exp;
end $$;
create or replace function public.set_member_role(p_member uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_m public.memberships; v_caller text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  if p_role not in ('admin','agent','viewer') then raise exception 'validation_failed' using errcode = '22023'; end if;
  select * into v_m from public.memberships where id = p_member for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select role into v_caller from public.memberships where org_id = v_m.org_id and user_id = v_uid;
  perform public.assert_aal2_if_privileged(v_m.org_id);
  if v_caller is null or v_caller not in ('owner','admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_m.user_id = v_uid or v_m.role = 'owner' then raise exception 'forbidden' using errcode = '42501'; end if;       -- no self-change, owner immutable
  if v_caller = 'admin' and (v_m.role = 'admin' or p_role = 'admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.memberships set role = p_role where id = p_member;
  perform public.append_audit(v_m.org_id, 'user', v_uid, 'member.role_change', 'membership', p_member::text, jsonb_build_object('from', v_m.role, 'to', p_role));
end $$;
create or replace function public.remove_member(p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_m public.memberships; v_caller text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_m from public.memberships where id = p_member for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select role into v_caller from public.memberships where org_id = v_m.org_id and user_id = v_uid;
  perform public.assert_aal2_if_privileged(v_m.org_id);
  if v_caller is null or v_caller not in ('owner','admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_m.role = 'owner' or v_m.user_id = v_uid then raise exception 'forbidden' using errcode = '42501'; end if;       -- last-owner safe: owners cannot be removed in Phase 2
  if v_caller = 'admin' and v_m.role = 'admin' then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.memberships where id = p_member;
  perform public.append_audit(v_m.org_id, 'user', v_uid, 'member.remove', 'membership', p_member::text, jsonb_build_object('role', v_m.role));
end $$;
create or replace function public.update_organization(p_org uuid, p_name text default null, p_retention_days int default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_caller text; v_fields text[] := '{}';
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select role into v_caller from public.memberships where org_id = p_org and user_id = v_uid;
  perform public.assert_aal2_if_privileged(p_org);
  if v_caller is null or v_caller not in ('owner','admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_name is null and p_retention_days is null then raise exception 'validation_failed' using errcode = '22023'; end if;
  if p_name is not null then v_fields := array_append(v_fields, 'name'); end if;
  if p_retention_days is not null then v_fields := array_append(v_fields, 'data_retention_days'); end if;
  update public.organizations set name = coalesce(trim(p_name), name), data_retention_days = coalesce(p_retention_days, data_retention_days) where id = p_org;
  perform public.append_audit(p_org, 'user', v_uid, 'org.update', 'organization', p_org::text, jsonb_build_object('fields', array_to_string(v_fields, ',')));
end $$;
-- grants: new functions default-deny; replaced functions keep their existing ACLs
revoke all on function public.is_aal2() from public, anon, authenticated;
revoke all on function public.assert_aal2_if_privileged(uuid) from public, anon, authenticated;
grant execute on function public.is_aal2() to authenticated, service_role;
grant execute on function public.assert_aal2_if_privileged(uuid) to service_role;
