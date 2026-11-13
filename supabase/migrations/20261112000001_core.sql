-- Phase 2 core migration. Source of truth: DATABASE.md (§1-§10). Phase 3+ tables (messages, KB, workflows, approvals ...) are NOT here.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ===== tenants & users =====
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  kill_switch boolean not null default false,
  data_retention_days int not null default 365 check (data_retention_days between 30 and 3650),
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_organizations_updated before update on public.organizations for each row execute function public.set_updated_at();

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','agent','viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_idx on public.memberships(user_id);

-- role helpers (security definer: bypass RLS to avoid policy recursion)
create function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()) $$;
create function public.has_role(p_org uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid() and m.role = any(p_roles)) $$;
create function public.shares_org_with(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships a join public.memberships b on a.org_id = b.org_id
                 where a.user_id = auth.uid() and b.user_id = p_user) $$;

-- ===== audit (append-only) =====
create table public.audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_type text not null check (actor_type in ('user','ai_agent','system')),
  actor_id uuid,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}',
  ip inet,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs(org_id, created_at desc);
create function public.audit_block_mutation() returns trigger language plpgsql as $$
begin raise exception 'audit_logs is append-only' using errcode = '42501'; end $$;
create trigger trg_audit_no_update before update or delete on public.audit_logs for each row execute function public.audit_block_mutation();
create trigger trg_audit_no_truncate before truncate on public.audit_logs for each statement execute function public.audit_block_mutation();

create function public.append_audit(
  p_org uuid, p_actor_type text, p_actor_id uuid, p_action text, p_target_type text, p_target_id text,
  p_metadata jsonb default '{}', p_ip inet default null, p_request_id text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  -- heuristic guard: secrets/bodies must never be written to audit metadata (DATABASE §5)
  if coalesce(p_metadata,'{}')::text ~* '"(token|secret|password|api_?key|authorization|ciphertext|value|body)"\s*:' then
    raise exception 'audit metadata contains forbidden key' using errcode = '22023';
  end if;
  insert into public.audit_logs(org_id, actor_type, actor_id, action, target_type, target_id, metadata, ip, request_id)
  values (p_org, p_actor_type, p_actor_id, p_action, p_target_type, p_target_id, coalesce(p_metadata,'{}'), p_ip, p_request_id)
  returning id into v;
  return v;
end $$;

-- ===== secrets =====
create table public.org_keys (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  wrapped_key bytea not null,
  key_version int not null default 1,
  created_at timestamptz not null default now()
);
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('email_smtp','email_inbound','http_connector','llm_byok','voice')),
  name text not null,
  config jsonb not null default '{}',  -- never secrets
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create table public.integration_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null,
  name text not null,
  ciphertext bytea not null,
  key_version int not null,
  last4 text not null check (char_length(last4) <= 4),
  rotated_at timestamptz not null default now(),
  unique (integration_id, name),
  foreign key (org_id, integration_id) references public.integrations(org_id, id) on delete cascade
);

-- ===== invitations =====
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(email)),
  role text not null check (role in ('admin','agent','viewer')),
  token_hash bytea not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid not null references auth.users(id),
  expires_at timestamptz not null default now() + interval '7 days' check (expires_at <= created_at + interval '14 days'),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index invitations_one_pending on public.invitations(org_id, email) where status = 'pending';
create index invitations_org_status_idx on public.invitations(org_id, status);

-- ===== channels & minimal conversation stubs (FK targets for chat_sessions / webhook_events) =====
create table public.channel_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('email','web_chat','voice')),
  name text not null,
  address text,
  public_key text unique default encode(extensions.gen_random_bytes(16), 'hex'),
  config jsonb not null default '{}',
  status text not null default 'active' check (status in ('active','paused','error')),
  integration_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, integration_id) references public.integrations(org_id, id)
);
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  display_name text, email text, phone text,
  tags text[] not null default '{}', custom_fields jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel_account_id uuid not null,
  customer_id uuid not null,
  status text not null default 'open' check (status in ('open','pending_approval','waiting_customer','resolved','closed')),
  assignee_id uuid references auth.users(id),
  ai_enabled boolean not null default true,
  subject text, last_message_at timestamptz, first_response_at timestamptz, resolved_at timestamptz,
  handoff_reason text, external_thread_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, channel_account_id, external_thread_id),
  foreign key (org_id, channel_account_id) references public.channel_accounts(org_id, id),
  foreign key (org_id, customer_id) references public.customers(org_id, id)
);
create index conversations_inbox_idx on public.conversations(org_id, status, last_message_at desc);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel_account_id uuid not null,
  conversation_id uuid not null,
  visitor_id text not null,
  token_hash bytea not null unique,
  expires_at timestamptz not null default now() + interval '24 hours',
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  ip_hash text, origin text,
  created_at timestamptz not null default now(),
  foreign key (org_id, channel_account_id) references public.channel_accounts(org_id, id),
  foreign key (org_id, conversation_id) references public.conversations(org_id, id)
);
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel_account_id uuid not null,
  provider text not null,
  external_event_id text not null,
  payload jsonb,                         -- nulled by purge_pii()
  status text not null default 'received' check (status in ('received','processed','failed')),
  received_at timestamptz not null default now(),
  unique (org_id, channel_account_id, external_event_id),
  foreign key (org_id, channel_account_id) references public.channel_accounts(org_id, id)
);

-- ===== idempotency / jobs / rate limits =====
create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  scope text not null, key text not null, request_hash text not null, response jsonb,
  status text not null default 'in_progress' check (status in ('in_progress','done')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  unique (org_id, scope, key)
);
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}',
  dedupe_key text not null,
  status text not null default 'queued' check (status in ('queued','running','done','failed','dead')),
  attempts int not null default 0,
  max_attempts int not null default 5 check (max_attempts between 1 and 5),
  run_at timestamptz not null default now(),
  locked_by text, locked_until timestamptz,
  last_error text, finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, type, dedupe_key)
);
create index jobs_status_run_idx on public.jobs(status, run_at);
create index jobs_status_lock_idx on public.jobs(status, locked_until);
create unlogged table public.rate_limits (
  key text not null, window_start timestamptz not null, count int not null default 0,
  primary key (key, window_start)
);

-- ===== RLS =====
do $$ declare t text; begin
  foreach t in array array['organizations','profiles','memberships','audit_logs','org_keys','integrations','integration_secrets',
    'invitations','channel_accounts','customers','conversations','chat_sessions','webhook_events','idempotency_keys','jobs','rate_limits'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop; end $$;

create policy org_select on public.organizations for select using (public.is_member(id));
create policy org_update on public.organizations for update using (public.has_role(id, array['owner','admin'])) with check (public.has_role(id, array['owner','admin']));
create policy org_delete on public.organizations for delete using (public.has_role(id, array['owner']));

create policy profiles_select on public.profiles for select using (id = auth.uid() or public.shares_org_with(id));
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy memberships_select on public.memberships for select using (user_id = auth.uid() or public.has_role(org_id, array['owner','admin']));
create policy audit_select on public.audit_logs for select using (public.has_role(org_id, array['owner','admin']));
create policy invitations_select on public.invitations for select using (public.has_role(org_id, array['owner','admin']));

create policy integrations_all on public.integrations for all using (public.has_role(org_id, array['owner','admin'])) with check (public.has_role(org_id, array['owner','admin']));
create policy channels_all on public.channel_accounts for all using (public.has_role(org_id, array['owner','admin'])) with check (public.has_role(org_id, array['owner','admin']));
create policy customers_select on public.customers for select using (public.is_member(org_id));
create policy customers_write on public.customers for insert with check (public.has_role(org_id, array['owner','admin','agent']));
create policy customers_update on public.customers for update using (public.has_role(org_id, array['owner','admin','agent'])) with check (public.has_role(org_id, array['owner','admin','agent']));
create policy customers_delete on public.customers for delete using (public.has_role(org_id, array['owner','admin']));
create policy conv_select on public.conversations for select using (public.is_member(org_id));
create policy conv_insert on public.conversations for insert with check (public.has_role(org_id, array['owner','admin','agent']));
create policy conv_update on public.conversations for update using (public.has_role(org_id, array['owner','admin','agent'])) with check (public.has_role(org_id, array['owner','admin','agent']));
create policy conv_delete on public.conversations for delete using (public.has_role(org_id, array['owner','admin']));
-- org_keys, integration_secrets, chat_sessions, webhook_events, idempotency_keys, jobs, rate_limits: NO policies (service_role only)

-- ===== table privileges (defense in depth beside RLS) =====
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select, update on public.organizations to authenticated;
grant delete on public.organizations to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.memberships, public.audit_logs to authenticated;
grant select (id, org_id, email, role, status, invited_by, expires_at, accepted_by, accepted_at, revoked_at, created_at) on public.invitations to authenticated; -- token_hash excluded
grant select, insert, update, delete on public.integrations, public.channel_accounts, public.customers, public.conversations to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
revoke update, delete, truncate on public.audit_logs from service_role;

-- ===== user-facing RPCs (security definer; each re-checks caller role) =====
create function public.create_organization(p_name text, p_slug text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_org uuid;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  insert into public.organizations(name, slug) values (trim(p_name), lower(trim(p_slug))) returning id into v_org;
  insert into public.memberships(org_id, user_id, role) values (v_org, v_uid, 'owner');
  perform public.append_audit(v_org, 'user', v_uid, 'org.create', 'organization', v_org::text, jsonb_build_object('slug', lower(trim(p_slug))));
  return v_org;
end $$;

create function public.create_invitation(p_org uuid, p_email text, p_role text)
returns table(inv_id uuid, inv_token text, inv_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_caller text; v_email text := lower(trim(p_email)); v_token text; v_id uuid; v_exp timestamptz;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select role into v_caller from public.memberships where org_id = p_org and user_id = v_uid;
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

create function public.accept_invitation(p_token text) returns table(out_org_id uuid, out_role text)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_mail text; v_other text; v_inv public.invitations;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select lower(email) into v_mail from auth.users where id = v_uid and email_confirmed_at is not null;
  if v_mail is null then raise exception 'email_mismatch' using errcode = '42501'; end if;
  select i.email into v_other from public.invitations i
   where i.token_hash = sha256(convert_to(p_token, 'UTF8')) and i.status = 'pending' and i.expires_at > now();
  if found and v_other <> v_mail then raise exception 'email_mismatch' using errcode = '42501'; end if;
  -- atomic single-use: only one concurrent caller can flip pending -> accepted
  update public.invitations i set status = 'accepted', accepted_by = v_uid, accepted_at = now()
   where i.token_hash = sha256(convert_to(p_token, 'UTF8')) and i.status = 'pending' and i.expires_at > now() and i.email = v_mail
   returning i.* into v_inv;
  if not found then raise exception 'invitation_invalid' using errcode = 'P0002'; end if;
  if exists (select 1 from public.memberships where org_id = v_inv.org_id and user_id = v_uid) then
    raise exception 'conflict' using errcode = '23505';   -- rolls back the acceptance; never upgrades an existing role
  end if;
  insert into public.memberships(org_id, user_id, role) values (v_inv.org_id, v_uid, v_inv.role);
  perform public.append_audit(v_inv.org_id, 'user', v_uid, 'invitation.accept', 'invitation', v_inv.id::text, jsonb_build_object('role', v_inv.role));
  return query select v_inv.org_id, v_inv.role;
end $$;

create function public.revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_inv public.invitations; v_caller text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_inv from public.invitations where id = p_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select role into v_caller from public.memberships where org_id = v_inv.org_id and user_id = v_uid;
  if v_caller is null or v_caller not in ('owner','admin') or (v_inv.role = 'admin' and v_caller <> 'owner') then
    raise exception 'forbidden' using errcode = '42501'; end if;
  update public.invitations set status = 'revoked', revoked_at = now() where id = p_id and status = 'pending';
  if not found then raise exception 'conflict' using errcode = '23505'; end if;
  perform public.append_audit(v_inv.org_id, 'user', v_uid, 'invitation.revoke', 'invitation', p_id::text);
end $$;

create function public.resend_invitation(p_id uuid) returns table(inv_token text, inv_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_inv public.invitations; v_caller text; v_token text; v_exp timestamptz;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_inv from public.invitations where id = p_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select role into v_caller from public.memberships where org_id = v_inv.org_id and user_id = v_uid;
  if v_caller is null or v_caller not in ('owner','admin') or (v_inv.role = 'admin' and v_caller <> 'owner') then
    raise exception 'forbidden' using errcode = '42501'; end if;
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=' || E'\n', '-_');
  update public.invitations set token_hash = sha256(convert_to(v_token, 'UTF8')), expires_at = now() + interval '7 days'
   where id = p_id and status = 'pending' returning invitations.expires_at into v_exp;
  if not found then raise exception 'conflict' using errcode = '23505'; end if;
  perform public.append_audit(v_inv.org_id, 'user', v_uid, 'invitation.resend', 'invitation', p_id::text);
  return query select v_token, v_exp;
end $$;

create function public.set_member_role(p_member uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_m public.memberships; v_caller text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  if p_role not in ('admin','agent','viewer') then raise exception 'validation_failed' using errcode = '22023'; end if;
  select * into v_m from public.memberships where id = p_member for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select role into v_caller from public.memberships where org_id = v_m.org_id and user_id = v_uid;
  if v_caller is null or v_caller not in ('owner','admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_m.user_id = v_uid or v_m.role = 'owner' then raise exception 'forbidden' using errcode = '42501'; end if;       -- no self-change, owner immutable
  if v_caller = 'admin' and (v_m.role = 'admin' or p_role = 'admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.memberships set role = p_role where id = p_member;
  perform public.append_audit(v_m.org_id, 'user', v_uid, 'member.role_change', 'membership', p_member::text, jsonb_build_object('from', v_m.role, 'to', p_role));
end $$;

create function public.remove_member(p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_m public.memberships; v_caller text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into v_m from public.memberships where id = p_member for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select role into v_caller from public.memberships where org_id = v_m.org_id and user_id = v_uid;
  if v_caller is null or v_caller not in ('owner','admin') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_m.role = 'owner' or v_m.user_id = v_uid then raise exception 'forbidden' using errcode = '42501'; end if;       -- last-owner safe: owners cannot be removed in Phase 2
  if v_caller = 'admin' and v_m.role = 'admin' then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.memberships where id = p_member;
  perform public.append_audit(v_m.org_id, 'user', v_uid, 'member.remove', 'membership', p_member::text, jsonb_build_object('role', v_m.role));
end $$;

-- ===== service-only RPCs =====
create function public.expire_invitations() returns int language plpgsql security definer set search_path = public as $$
declare n int; begin
  update public.invitations set status = 'expired' where status = 'pending' and expires_at <= now();
  get diagnostics n = row_count; return n; end $$;

create function public.rate_limit_hit(p_key text, p_limit int, p_window_seconds int)
returns table(out_allowed boolean, out_count int, out_retry_after int)
language plpgsql security definer set search_path = public as $$
declare v_start timestamptz; v_count int;
begin
  if p_limit < 1 or p_window_seconds < 1 then raise exception 'validation_failed' using errcode = '22023'; end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits(key, window_start, count) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning public.rate_limits.count into v_count;
  return query select v_count <= p_limit, v_count, greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - now())))::int);
end $$;

create function public.purge_rate_limits() returns int language plpgsql security definer set search_path = public as $$
declare n int; begin delete from public.rate_limits where window_start < now() - interval '2 hours'; get diagnostics n = row_count; return n; end $$;

create function public.idem_begin(p_org uuid, p_scope text, p_key text, p_hash text)
returns table(out_state text, out_response jsonb)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; r public.idempotency_keys;
begin
  insert into public.idempotency_keys(org_id, scope, key, request_hash) values (p_org, p_scope, p_key, p_hash)
  on conflict (org_id, scope, key) do nothing returning id into v_id;
  if v_id is not null then return query select 'new'::text, null::jsonb; return; end if;
  select * into r from public.idempotency_keys where org_id = p_org and scope = p_scope and key = p_key;
  if r.expires_at < now() or (r.status = 'in_progress' and r.created_at < now() - interval '5 minutes') then
    update public.idempotency_keys set request_hash = p_hash, status = 'in_progress', response = null, created_at = now(), expires_at = now() + interval '24 hours'
     where id = r.id and (expires_at < now() or (status = 'in_progress' and created_at < now() - interval '5 minutes')) returning id into v_id;
    if v_id is not null then return query select 'new'::text, null::jsonb; return; end if;
    select * into r from public.idempotency_keys where id = r.id;
  end if;
  if r.request_hash <> p_hash then return query select 'mismatch'::text, null::jsonb;
  elsif r.status = 'done' then return query select 'replay'::text, r.response;
  else return query select 'in_progress'::text, null::jsonb; end if;
end $$;

create function public.idem_finish(p_org uuid, p_scope text, p_key text, p_response jsonb) returns void
language sql security definer set search_path = public as $$
  update public.idempotency_keys set status = 'done', response = p_response where org_id = p_org and scope = p_scope and key = p_key $$;

create function public.idem_release(p_org uuid, p_scope text, p_key text) returns void
language sql security definer set search_path = public as $$
  delete from public.idempotency_keys where org_id = p_org and scope = p_scope and key = p_key and status = 'in_progress' $$;

create function public.enqueue_job(p_org uuid, p_type text, p_payload jsonb, p_dedupe text, p_run_at timestamptz default now(), p_max_attempts int default 5)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid; begin
  insert into public.jobs(org_id, type, payload, dedupe_key, run_at, max_attempts)
  values (p_org, p_type, coalesce(p_payload,'{}'), p_dedupe, p_run_at, least(greatest(p_max_attempts,1),5))
  on conflict (org_id, type, dedupe_key) do nothing returning id into v;
  return v; end $$;

create function public.claim_jobs(p_worker text, p_limit int default 10) returns setof public.jobs
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  -- reaper: expired leases with no attempts left -> dead
  with d as (update public.jobs set status = 'dead', last_error = 'lease expired; max_attempts reached', finished_at = now(), locked_by = null, locked_until = null
              where status = 'running' and locked_until < now() and attempts >= max_attempts returning id, org_id, type)
  select count(public.append_audit(d.org_id, 'system', null, 'job.dead', 'job', d.id::text, jsonb_build_object('type', d.type, 'reason', 'lease_expired'))) into v_n from d;
  -- atomic claim: queued/failed due jobs AND running jobs whose lease expired
  return query
  update public.jobs j set status = 'running', locked_by = p_worker, locked_until = now() + interval '2 minutes', attempts = j.attempts + 1
   where j.id in (select id from public.jobs
                   where attempts < max_attempts
                     and ((status in ('queued','failed') and run_at <= now()) or (status = 'running' and locked_until < now()))
                   order by run_at limit greatest(p_limit,1) for update skip locked)
  returning j.*;
end $$;

create function public.complete_job(p_id uuid, p_worker text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int; begin
  update public.jobs set status = 'done', finished_at = now(), locked_by = null, locked_until = null
   where id = p_id and locked_by = p_worker and status = 'running';
  get diagnostics n = row_count; return n = 1; end $$;

create function public.heartbeat_job(p_id uuid, p_worker text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int; begin
  update public.jobs set locked_until = now() + interval '2 minutes' where id = p_id and locked_by = p_worker and status = 'running';
  get diagnostics n = row_count; return n = 1; end $$;

create function public.fail_job(p_id uuid, p_worker text, p_error text, p_retryable boolean default true) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_org uuid; v_type text;
begin
  update public.jobs set
    status = case when not p_retryable or attempts >= max_attempts then 'dead' else 'failed' end,
    last_error = left(p_error, 1000),
    run_at = case when not p_retryable or attempts >= max_attempts then run_at
                  else now() + make_interval(secs => least(30 * power(2, attempts - 1), 1800) * (0.8 + random() * 0.4)) end,
    finished_at = case when not p_retryable or attempts >= max_attempts then now() end,
    locked_by = null, locked_until = null
   where id = p_id and locked_by = p_worker and status = 'running'
   returning status, org_id, type into v_status, v_org, v_type;
  if v_status is null then return 'lost'; end if;
  if v_status = 'dead' then
    perform public.append_audit(v_org, 'system', null, 'job.dead', 'job', p_id::text, jsonb_build_object('type', v_type, 'retryable', p_retryable));
  end if;
  return v_status;
end $$;

create function public.purge_pii() returns table(out_webhook_payloads int, out_jobs int, out_idempotency int)
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; begin
  update public.webhook_events set payload = null
   where payload is not null and ((status = 'processed' and received_at < now() - interval '7 days') or (status <> 'processed' and received_at < now() - interval '30 days'));
  get diagnostics a = row_count;
  delete from public.jobs where status = 'done' and finished_at < now() - interval '30 days';
  get diagnostics b = row_count;
  delete from public.idempotency_keys where expires_at < now();
  get diagnostics c = row_count;
  return query select a, b, c; end $$;

-- atomic data-key rotation: swap wrapped key and re-encrypted secrets in one transaction (optimistic version check)
create function public.rotate_org_key(p_org uuid, p_wrapped_hex text, p_new_version int, p_secrets jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare n int; total int;
begin
  update public.org_keys set wrapped_key = decode(p_wrapped_hex, 'hex'), key_version = p_new_version where org_id = p_org and key_version = p_new_version - 1;
  if not found then raise exception 'conflict' using errcode = '23505'; end if;
  update public.integration_secrets s set ciphertext = decode(x.ciphertext, 'hex'), key_version = p_new_version, rotated_at = now()
    from jsonb_to_recordset(p_secrets) as x(id uuid, ciphertext text) where s.id = x.id and s.org_id = p_org;
  get diagnostics n = row_count;
  select count(*) into total from public.integration_secrets where org_id = p_org;
  if n <> total then raise exception 'rotation incomplete' using errcode = '23514'; end if;
  perform public.append_audit(p_org, 'system', null, 'secrets.key_rotate', 'org_key', p_org::text, jsonb_build_object('version', p_new_version));
end $$;

-- ===== function privileges: default-deny, then explicit grants =====
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop; end $$;
grant execute on function public.is_member(uuid), public.has_role(uuid, text[]), public.shares_org_with(uuid) to authenticated;
grant execute on function public.create_organization(text, text), public.create_invitation(uuid, text, text), public.accept_invitation(text),
  public.revoke_invitation(uuid), public.resend_invitation(uuid), public.set_member_role(uuid, text), public.remove_member(uuid) to authenticated;
