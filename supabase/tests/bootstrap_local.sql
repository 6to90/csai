-- LOCAL TEST STUB ONLY: mimics the Supabase pieces the migration depends on (roles, auth.users, auth.uid()).
-- NOT part of the real Supabase deployment, and NOT a substitute for testing on real Supabase (PostgREST/GoTrue/Realtime).
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz);
-- same logic as Supabase's auth.uid(): legacy GUC first, then the JSON claims GUC that PostgREST >= 10 sets
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create schema extensions;
-- same logic as Supabase's auth.jwt()
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
-- Supabase grants everything on new public objects to these roles by default; replicate so tests prove our REVOKEs work.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
