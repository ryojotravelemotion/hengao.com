-- =====================================================================
--  変顔.com  /  Supabase スキーマ
--  Supabase ダッシュボード → SQL Editor に貼り付けて実行してください。
--  何度実行しても壊れないように書いてあります（冪等）。
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- テーブル
-- ---------------------------------------------------------------------

-- 変顔の投稿
create table if not exists public.posts (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  nickname       text not null default '名無しの変顔',
  caption        text not null default '',
  image_path     text not null,                 -- faces バケット内のパス 例: 2026/09/<uuid>.jpg
  width          int,
  height         int,
  reaction_count int  not null default 0,       -- 並び替え用の合計値
  reactions      jsonb not null default '{}'::jsonb,  -- 種類ごとの内訳 {"warota": 12, ...}
  comment_count  int  not null default 0,
  report_count   int  not null default 0,
  is_hidden      boolean not null default false,
  constraint posts_nickname_len check (char_length(nickname) between 1 and 20),
  constraint posts_caption_len  check (char_length(caption) <= 140),
  constraint posts_image_path_fmt check (image_path ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$')
);

-- コメント
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  nickname   text not null default '名無しさん',
  body       text not null,
  is_hidden  boolean not null default false,
  report_count int not null default 0,
  constraint comments_nickname_len check (char_length(nickname) between 1 and 20),
  constraint comments_body_len     check (char_length(body) between 1 and 300)
);

-- リアクション（1訪問者・1投稿・1種類につき1行）
create table if not exists public.reactions (
  post_id    uuid not null references public.posts(id) on delete cascade,
  visitor    text not null,
  kind       text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, visitor, kind),
  constraint reactions_kind_valid check (kind in ('warota','sugoi','kowai','suki')),
  constraint reactions_visitor_len check (char_length(visitor) between 8 and 64)
);

-- 削除キーのハッシュ（クライアントからは一切読めない）
create table if not exists public.content_secrets (
  ref_type text not null check (ref_type in ('post','comment')),
  ref_id   uuid not null,
  key_hash text not null,
  primary key (ref_type, ref_id)
);

-- 通報
create table if not exists public.reports (
  id         uuid primary key default gen_random_uuid(),
  ref_type   text not null check (ref_type in ('post','comment')),
  ref_id     uuid not null,
  reason     text not null default '',
  visitor    text not null,
  created_at timestamptz not null default now(),
  unique (ref_type, ref_id, visitor),
  constraint reports_reason_len check (char_length(reason) <= 200)
);

-- 投稿レート制限用の記録
create table if not exists public.post_events (
  id         bigserial primary key,
  visitor    text not null,
  kind       text not null,
  created_at timestamptz not null default now()
);

create index if not exists posts_new_idx     on public.posts (created_at desc) where not is_hidden;
create index if not exists posts_hot_idx     on public.posts (reaction_count desc, created_at desc) where not is_hidden;
create index if not exists comments_post_idx on public.comments (post_id, created_at) where not is_hidden;
create index if not exists reactions_visitor_idx on public.reactions (visitor);
create index if not exists post_events_idx   on public.post_events (visitor, created_at desc);

-- ---------------------------------------------------------------------
-- 集計をトリガーで自動更新
-- ---------------------------------------------------------------------

create or replace function public.sync_reaction_counts() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_post uuid := coalesce(new.post_id, old.post_id);
begin
  update public.posts p
     set reactions = coalesce((
           select jsonb_object_agg(r.kind, r.n)
             from (select kind, count(*)::int as n
                     from public.reactions where post_id = v_post group by kind) r
         ), '{}'::jsonb),
         reaction_count = (select count(*) from public.reactions where post_id = v_post)
   where p.id = v_post;
  return null;
end $$;

drop trigger if exists reactions_sync on public.reactions;
create trigger reactions_sync after insert or delete on public.reactions
  for each row execute function public.sync_reaction_counts();

create or replace function public.sync_comment_count() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_post uuid := coalesce(new.post_id, old.post_id);
begin
  update public.posts p
     set comment_count = (select count(*) from public.comments
                           where post_id = v_post and not is_hidden)
   where p.id = v_post;
  return null;
end $$;

drop trigger if exists comments_sync on public.comments;
create trigger comments_sync after insert or update or delete on public.comments
  for each row execute function public.sync_comment_count();

-- 投稿・コメントが消えたら、それにぶら下がる削除キー・通報・画像も片付ける
-- （RPC 経由の削除だけでなく、管理画面から直接消したときにも効く）
create or replace function public.cleanup_after_post_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.content_secrets where ref_type = 'post' and ref_id = old.id;
  delete from public.reports         where ref_type = 'post' and ref_id = old.id;
  if old.image_path is not null then
    delete from storage.objects where bucket_id = 'faces' and name = old.image_path;
  end if;
  return null;
end $$;

create or replace function public.cleanup_after_comment_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.content_secrets where ref_type = 'comment' and ref_id = old.id;
  delete from public.reports         where ref_type = 'comment' and ref_id = old.id;
  return null;
end $$;

drop trigger if exists posts_cleanup on public.posts;
create trigger posts_cleanup after delete on public.posts
  for each row execute function public.cleanup_after_post_delete();

drop trigger if exists comments_cleanup on public.comments;
create trigger comments_cleanup after delete on public.comments
  for each row execute function public.cleanup_after_comment_delete();

-- ---------------------------------------------------------------------
-- 行レベルセキュリティ
--   読む   … 誰でも（非表示のものを除く）
--   書く   … 直接は禁止。下の RPC 関数を通してのみ。
-- ---------------------------------------------------------------------

alter table public.posts           enable row level security;
alter table public.comments        enable row level security;
alter table public.reactions       enable row level security;
alter table public.content_secrets enable row level security;
alter table public.reports         enable row level security;
alter table public.post_events     enable row level security;

drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts for select to anon, authenticated using (not is_hidden);

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select to anon, authenticated using (not is_hidden);

drop policy if exists reactions_read on public.reactions;
create policy reactions_read on public.reactions for select to anon, authenticated using (true);

-- 秘密情報とレート制限テーブルはポリシーを一切作らない＝匿名からは完全に不可視
revoke all on public.content_secrets from anon, authenticated;
revoke all on public.reports         from anon, authenticated;
revoke all on public.post_events     from anon, authenticated;

-- 書き込みは RPC 経由のみ
revoke insert, update, delete on public.posts     from anon, authenticated;
revoke insert, update, delete on public.comments  from anon, authenticated;
revoke insert, update, delete on public.reactions from anon, authenticated;

-- 読み取りの権限は明示しておく。
-- プロジェクト作成時の「Automatically expose new tables」の設定に関わらず
-- 同じように動かすため（読める中身は上のポリシーが決める）。
grant usage on schema public to anon, authenticated;
grant select on public.posts     to anon, authenticated;
grant select on public.comments  to anon, authenticated;
grant select on public.reactions to anon, authenticated;

-- ---------------------------------------------------------------------
-- ストレージ（画像）
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('faces', 'faces', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "faces are publicly readable" on storage.objects;
create policy "faces are publicly readable" on storage.objects
  for select to anon, authenticated using (bucket_id = 'faces');

drop policy if exists "anyone can upload a face" on storage.objects;
create policy "anyone can upload a face" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'faces');
-- 更新・削除のポリシーは作らない（一度上げた画像は本人でも RPC 経由でしか消せない）

-- ---------------------------------------------------------------------
-- RPC: 投稿する
-- ---------------------------------------------------------------------

create or replace function public.create_post(
  p_image_path text,
  p_delete_key text,
  p_visitor    text,
  p_nickname   text default null,
  p_caption    text default null,
  p_width      int  default null,
  p_height     int  default null
) returns public.posts
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_post   public.posts;
  v_recent int;
begin
  if coalesce(char_length(p_delete_key), 0) < 4 then
    raise exception '削除キーは4文字以上にしてください' using errcode = '22023';
  end if;
  if coalesce(char_length(p_visitor), 0) < 8 then
    raise exception 'ブラウザの識別子が不正です' using errcode = '22023';
  end if;

  -- 画像が本当にアップロードされているか確認
  if not exists (select 1 from storage.objects
                  where bucket_id = 'faces' and name = p_image_path) then
    raise exception '画像が見つかりません' using errcode = '22023';
  end if;

  -- 同じ画像で二重投稿しない
  if exists (select 1 from public.posts where image_path = p_image_path) then
    raise exception 'この画像はすでに投稿されています' using errcode = '23505';
  end if;

  -- 1時間に10件まで
  select count(*) into v_recent from public.post_events
   where visitor = p_visitor and kind = 'post' and created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception '投稿しすぎです。1時間ほど休んでからどうぞ' using errcode = '54000';
  end if;

  insert into public.posts (nickname, caption, image_path, width, height)
  values (
    nullif(btrim(coalesce(p_nickname, '')), ''),
    left(btrim(coalesce(p_caption, '')), 140),
    p_image_path,
    p_width,
    p_height
  )
  returning * into v_post;

  insert into public.content_secrets (ref_type, ref_id, key_hash)
  values ('post', v_post.id, extensions.crypt(p_delete_key, extensions.gen_salt('bf')));

  insert into public.post_events (visitor, kind) values (p_visitor, 'post');

  return v_post;
end $$;

-- nickname が null のときはデフォルト値を使いたいので、明示的に処理
create or replace function public.normalize_nickname() returns trigger
language plpgsql as $$
begin
  if new.nickname is null or btrim(new.nickname) = '' then
    new.nickname := case tg_table_name when 'comments' then '名無しさん' else '名無しの変顔' end;
  else
    new.nickname := left(btrim(new.nickname), 20);
  end if;
  return new;
end $$;

drop trigger if exists posts_nickname on public.posts;
create trigger posts_nickname before insert or update on public.posts
  for each row execute function public.normalize_nickname();

drop trigger if exists comments_nickname on public.comments;
create trigger comments_nickname before insert or update on public.comments
  for each row execute function public.normalize_nickname();

-- ---------------------------------------------------------------------
-- RPC: コメントする
-- ---------------------------------------------------------------------

create or replace function public.add_comment(
  p_post_id    uuid,
  p_body       text,
  p_delete_key text,
  p_visitor    text,
  p_nickname   text default null
) returns public.comments
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_comment public.comments;
  v_recent  int;
begin
  if coalesce(char_length(p_delete_key), 0) < 4 then
    raise exception '削除キーは4文字以上にしてください' using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_body)), 0) = 0 then
    raise exception 'コメントが空です' using errcode = '22023';
  end if;
  if not exists (select 1 from public.posts where id = p_post_id and not is_hidden) then
    raise exception 'この投稿は見つかりません' using errcode = '22023';
  end if;

  select count(*) into v_recent from public.post_events
   where visitor = p_visitor and kind = 'comment' and created_at > now() - interval '5 minutes';
  if v_recent >= 15 then
    raise exception 'コメントが速すぎます。少し待ってからどうぞ' using errcode = '54000';
  end if;

  insert into public.comments (post_id, nickname, body)
  values (p_post_id, nullif(btrim(coalesce(p_nickname, '')), ''), left(btrim(p_body), 300))
  returning * into v_comment;

  insert into public.content_secrets (ref_type, ref_id, key_hash)
  values ('comment', v_comment.id, extensions.crypt(p_delete_key, extensions.gen_salt('bf')));

  insert into public.post_events (visitor, kind) values (p_visitor, 'comment');

  return v_comment;
end $$;

-- ---------------------------------------------------------------------
-- RPC: リアクションを付ける／外す
-- ---------------------------------------------------------------------

create or replace function public.toggle_reaction(
  p_post_id uuid,
  p_kind    text,
  p_visitor text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reacted boolean;
  v_post    public.posts;
begin
  if not exists (select 1 from public.posts where id = p_post_id and not is_hidden) then
    raise exception 'この投稿は見つかりません' using errcode = '22023';
  end if;

  delete from public.reactions
   where post_id = p_post_id and visitor = p_visitor and kind = p_kind;

  if found then
    v_reacted := false;
  else
    insert into public.reactions (post_id, visitor, kind) values (p_post_id, p_visitor, p_kind);
    v_reacted := true;
  end if;

  select * into v_post from public.posts where id = p_post_id;
  return jsonb_build_object(
    'reacted', v_reacted,
    'reactions', v_post.reactions,
    'reaction_count', v_post.reaction_count
  );
end $$;

-- ---------------------------------------------------------------------
-- RPC: 削除する（削除キーを知っている人だけ）
-- ---------------------------------------------------------------------

create or replace function public.delete_post(p_post_id uuid, p_delete_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text;
begin
  select key_hash into v_hash from public.content_secrets
   where ref_type = 'post' and ref_id = p_post_id;
  if v_hash is null or v_hash <> extensions.crypt(p_delete_key, v_hash) then
    raise exception '削除キーが違います' using errcode = '42501';
  end if;

  -- コメント・リアクションは連鎖削除、削除キーと画像はトリガーが片付ける
  delete from public.posts where id = p_post_id;
  return true;
end $$;

create or replace function public.delete_comment(p_comment_id uuid, p_delete_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_ok boolean := false;
  v_hash text;
  v_post uuid;
begin
  select post_id into v_post from public.comments where id = p_comment_id;
  if v_post is null then
    raise exception 'このコメントは見つかりません' using errcode = '22023';
  end if;

  -- コメント本人の鍵、または投稿主の鍵でも消せる
  for v_hash in
    select key_hash from public.content_secrets
     where (ref_type = 'comment' and ref_id = p_comment_id)
        or (ref_type = 'post'    and ref_id = v_post)
  loop
    if v_hash = extensions.crypt(p_delete_key, v_hash) then
      v_ok := true;
    end if;
  end loop;

  if not v_ok then
    raise exception '削除キーが違います' using errcode = '42501';
  end if;

  delete from public.comments where id = p_comment_id;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 通報する（同じ投稿に3人集まったら自動で非表示）
-- ---------------------------------------------------------------------

create or replace function public.report_content(
  p_ref_type text,
  p_ref_id   uuid,
  p_visitor  text,
  p_reason   text default ''
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  if p_ref_type not in ('post','comment') then
    raise exception '通報の種類が不正です' using errcode = '22023';
  end if;

  insert into public.reports (ref_type, ref_id, visitor, reason)
  values (p_ref_type, p_ref_id, p_visitor, left(coalesce(p_reason, ''), 200))
  on conflict (ref_type, ref_id, visitor) do nothing;

  select count(*) into v_count from public.reports
   where ref_type = p_ref_type and ref_id = p_ref_id;

  if p_ref_type = 'post' then
    update public.posts set report_count = v_count, is_hidden = (v_count >= 3)
     where id = p_ref_id;
  else
    update public.comments set report_count = v_count, is_hidden = (v_count >= 3)
     where id = p_ref_id;
  end if;

  return true;
end $$;

-- 実行権限（読み取り専用の匿名ユーザーにも RPC は許可する）
grant execute on function public.create_post(text,text,text,text,text,int,int)  to anon, authenticated;
grant execute on function public.add_comment(uuid,text,text,text,text)          to anon, authenticated;
grant execute on function public.toggle_reaction(uuid,text,text)                to anon, authenticated;
grant execute on function public.delete_post(uuid,text)                         to anon, authenticated;
grant execute on function public.delete_comment(uuid,text)                      to anon, authenticated;
grant execute on function public.report_content(text,uuid,text,text)            to anon, authenticated;

-- 内部用の関数は匿名から呼べないようにする
revoke execute on function public.sync_reaction_counts() from anon, authenticated;
revoke execute on function public.sync_comment_count()   from anon, authenticated;
revoke execute on function public.normalize_nickname()   from anon, authenticated;
revoke execute on function public.cleanup_after_post_delete()    from anon, authenticated;
revoke execute on function public.cleanup_after_comment_delete() from anon, authenticated;
