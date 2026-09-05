\set ON_ERROR_STOP on
\set QUIET on
\pset pager off

-- 画像が2枚アップロード済みという想定
insert into storage.objects (bucket_id, name) values
  ('faces','2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg'),
  ('faces','2026/09/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg');

set role anon;

\echo '### 1. anon はテーブルに直接書き込めない'
do $$ begin
  begin
    insert into public.posts (image_path) values ('2026/09/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg');
    raise exception 'FAIL: 直接 insert できてしまった';
  exception when insufficient_privilege or others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'OK: 直接 insert は拒否 (%)', sqlerrm;
  end;
end $$;

\echo '### 2. anon は削除キーのハッシュを読めない'
do $$ declare n int; begin
  begin
    select count(*) into n from public.content_secrets;
    raise exception 'FAIL: content_secrets が読めてしまった (% 行)', n;
  exception when insufficient_privilege then
    raise notice 'OK: content_secrets は読めない';
  end;
end $$;

\echo '### 3. 投稿できる'
select id as post_id from public.create_post(
  p_image_path => '2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
  p_delete_key => 'himitsu',
  p_visitor    => 'visitor-0000000001',
  p_nickname   => '  へんがおマスター  ',
  p_caption    => '会心の一枚'
) \gset

\echo '### 4. 同じ画像は二重投稿できない / 存在しない画像は投稿できない'
do $$ begin
  begin
    perform public.create_post('2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg','himitsu','visitor-0000000002');
    raise exception 'FAIL: 二重投稿できてしまった';
  exception when unique_violation then raise notice 'OK: 二重投稿を拒否'; end;
  begin
    perform public.create_post('2026/09/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg','himitsu','visitor-0000000002');
    raise exception 'FAIL: 存在しない画像で投稿できてしまった';
  exception when invalid_parameter_value then raise notice 'OK: 未アップロードの画像を拒否'; end;
  begin
    perform public.create_post('../../etc/passwd','himitsu','visitor-0000000002');
    raise exception 'FAIL: 不正なパスを受け付けた';
  exception when check_violation or invalid_parameter_value then raise notice 'OK: 不正なパスを拒否'; end;
  begin
    perform public.create_post('2026/09/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg','abc','visitor-0000000002');
    raise exception 'FAIL: 短すぎる削除キーが通った';
  exception when invalid_parameter_value then raise notice 'OK: 4文字未満の削除キーを拒否'; end;
end $$;

\echo '### 5. ニックネームの前後の空白は削られる'
select case when nickname = 'へんがおマスター' then 'OK: nickname=' || nickname
            else 'FAIL: ' || nickname end from public.posts where id = :'post_id';

\echo '### 6. リアクションは付け外しできて集計される'
select public.toggle_reaction(:'post_id','warota','visitor-0000000001') as r1 \gset
select public.toggle_reaction(:'post_id','warota','visitor-0000000002');
select public.toggle_reaction(:'post_id','sugoi', 'visitor-0000000002');
select case when reaction_count = 3 and reactions->>'warota' = '2' and reactions->>'sugoi' = '1'
            then 'OK: 3件 ' || reactions::text else 'FAIL: ' || reaction_count || ' ' || reactions::text end
  from public.posts where id = :'post_id';
select public.toggle_reaction(:'post_id','warota','visitor-0000000002');  -- 取り消し
select case when reaction_count = 2 and reactions->>'warota' = '1'
            then 'OK: 取り消し後 ' || reactions::text else 'FAIL: ' || reactions::text end
  from public.posts where id = :'post_id';

\echo '### 7. コメントできてカウントが増える'
select id as c1 from public.add_comment(:'post_id','くっそわろた','comment-key','visitor-0000000002','通りすがり') \gset
select id as c2 from public.add_comment(:'post_id','これはひどい','other-key','visitor-0000000003') \gset
select case when comment_count = 2 then 'OK: コメント2件' else 'FAIL: ' || comment_count end
  from public.posts where id = :'post_id';
select case when nickname = '名無しさん' then 'OK: 既定のニックネーム' else 'FAIL: ' || nickname end
  from public.comments where id = :'c2';

\echo '### 8. 削除キーが違うと消せない'
select set_config('test.c1', :'c1', false), set_config('test.post', :'post_id', false);
do $$ begin
  begin
    perform public.delete_comment(current_setting('test.c1')::uuid, 'wrong-key');
    raise exception 'FAIL: 誤った鍵でコメントを削除できてしまった';
  exception when insufficient_privilege then raise notice 'OK: 誤った削除キーを拒否'; end;
  begin
    perform public.delete_post(current_setting('test.post')::uuid, 'chigau-kagi');
    raise exception 'FAIL: 誤った鍵で投稿を削除できてしまった';
  exception when insufficient_privilege then raise notice 'OK: 投稿も誤った鍵では消せない'; end;
end $$;

\echo '### 9. 投稿主の鍵で他人のコメントを消せる'
select case when public.delete_comment(:'c2','himitsu') then 'OK: 投稿主が削除' else 'FAIL' end;
select case when comment_count = 1 then 'OK: コメント1件に減った' else 'FAIL: ' || comment_count end
  from public.posts where id = :'post_id';

\echo '### 10. 3人に通報されたら自動で非表示になる'
select public.report_content('post', :'post_id', 'visitor-0000000010', 'ひどい');
select public.report_content('post', :'post_id', 'visitor-0000000010', '重複は無視');
select case when count(*) = 1 then 'OK: 通報はまだ非表示にならない' else 'FAIL' end
  from public.posts where id = :'post_id';
select public.report_content('post', :'post_id', 'visitor-0000000011');
select public.report_content('post', :'post_id', 'visitor-0000000012');
select case when count(*) = 0 then 'OK: 3件で非表示になった' else 'FAIL: まだ見える' end
  from public.posts where id = :'post_id';

\echo '### 11. 正しい鍵で投稿を削除すると画像も消える'
select case when public.delete_post(:'post_id','himitsu') then 'OK: 削除成功' else 'FAIL' end;
reset role;
select case when count(*) = 0 then 'OK: 画像も storage から消えた' else 'FAIL: 画像が残っている' end
  from storage.objects where name = '2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg';
select case when count(*) = 0 then 'OK: コメントも連鎖削除' else 'FAIL' end from public.comments;
select case when count(*) = 0 then 'OK: 削除キーも消えた' else 'FAIL' end from public.content_secrets;
