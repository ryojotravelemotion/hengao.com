-- 変顔.com のスキーマをローカル検証するための Supabase 環境の最小再現。
-- 本番の Supabase では不要（あちらには最初から存在するもの）。
-- Supabase 環境の最小再現（ローカル検証用）
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists extensions;
create schema if not exists storage;
create table storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid, created_at timestamptz default now()
);
grant usage on schema public, extensions, storage to anon, authenticated;
-- Supabase のデフォルト権限を模倣（新規テーブルに anon が全権を持つ状態）
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
