-- 접근 제어·상태 일관성 검증. run.sh가 stub + 마이그레이션 적용 후 실행합니다.
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'other@example.com');

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

create function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'PASS: %', msg;
end $$;

-- ── 소유자 A: 프로젝트·리액션·후보 생성 ──
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
insert into public.projects (id, name, character_name) values ('aaaaaaaa-0000-0000-0000-000000000001', '테스트', '하루');
insert into public.reactions (id, project_id, emotion) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '당황'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '수줍음');
select pg_temp.ok((select owner_id from public.projects) = '11111111-1111-1111-1111-111111111111', 'owner_id 기본값이 auth.uid()');

insert into storage.objects (bucket_id, name) values
  ('reaction-images', '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-000000000001/b1/c1.png');
select pg_temp.ok(true, '소유자는 자기 폴더에 이미지 업로드 가능');

insert into public.candidates (id, project_id, reaction_id, storage_path, mime_type, ext, byte_size, sha256) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-000000000001/b1/c1.png', 'image/png', 'png', 10, repeat('a', 64)),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-000000000001/b1/c2.png', 'image/png', 'png', 10, repeat('b', 64));
select pg_temp.ok((select status from public.reactions where id = 'bbbbbbbb-0000-0000-0000-000000000001') = 'generated', '첫 이미지 등록 시 미작업 → 생성됨');
select pg_temp.ok((select version from public.reactions where id = 'bbbbbbbb-0000-0000-0000-000000000001') = 2, '자동 상태 변경 시 버전 증가');

-- 채택
update public.reactions set status = 'adopted', adopted_candidate_id = 'cccccccc-0000-0000-0000-000000000001'
 where id = 'bbbbbbbb-0000-0000-0000-000000000001';
select pg_temp.ok((select status from public.reactions where id = 'bbbbbbbb-0000-0000-0000-000000000001') = 'adopted', '채택 반영');

-- 상태와 채택 불일치는 거부
do $$ begin
  update public.reactions set status = 'rework' where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  raise exception 'FAIL: 채택 이미지가 있는데 재작업 상태 허용됨';
exception when check_violation then raise notice 'PASS: 채택 이미지만 남기고 상태를 바꾸는 것 거부';
end $$;
do $$ begin
  update public.reactions set status = 'adopted', adopted_candidate_id = null where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  raise exception 'FAIL: 채택 이미지 없는 채택 허용됨';
exception when check_violation then raise notice 'PASS: 채택 이미지 없이 채택 상태 거부';
end $$;
-- 다른 리액션의 후보를 채택하는 것은 거부
do $$ begin
  update public.reactions set status = 'adopted', adopted_candidate_id = 'cccccccc-0000-0000-0000-000000000001'
   where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  raise exception 'FAIL: 다른 리액션의 후보 채택 허용됨';
exception when foreign_key_violation then raise notice 'PASS: 다른 리액션의 후보는 채택 불가';
end $$;

-- 버전 확인 갱신: 오래된 버전으로는 0행
do $$ declare n int; begin
  update public.reactions set emotion = '오래된 화면', version = version + 1
   where id = 'bbbbbbbb-0000-0000-0000-000000000001' and version = 1;
  get diagnostics n = row_count;
  perform pg_temp.ok(n = 0, '오래된 버전으로 저장하면 갱신되지 않음(충돌 감지)');
end $$;

-- 채택 이미지 삭제 → 채택 해제, 남은 후보가 있으므로 생성됨
delete from public.candidates where id = 'cccccccc-0000-0000-0000-000000000001';
select pg_temp.ok((select status = 'generated' and adopted_candidate_id is null from public.reactions where id = 'bbbbbbbb-0000-0000-0000-000000000001'), '채택 이미지 삭제 시 채택 해제 → 생성됨');
-- 마지막 후보 삭제 → 미작업
delete from public.candidates where id = 'cccccccc-0000-0000-0000-000000000002';
select pg_temp.ok((select status from public.reactions where id = 'bbbbbbbb-0000-0000-0000-000000000001') = 'todo', '후보가 모두 없어지면 미작업');

-- 채택 상태에서 리액션 삭제(연쇄 삭제)
insert into public.candidates (id, project_id, reaction_id, storage_path, mime_type, ext, byte_size, sha256) values
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-000000000001/b2/c3.png', 'image/png', 'png', 10, repeat('c', 64));
update public.reactions set status = 'adopted', adopted_candidate_id = 'cccccccc-0000-0000-0000-000000000003' where id = 'bbbbbbbb-0000-0000-0000-000000000002';
delete from public.reactions where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok(not exists (select 1 from public.candidates where id = 'cccccccc-0000-0000-0000-000000000003'), '채택된 리액션 삭제 시 후보도 함께 삭제');

-- 다시 후보 하나 추가해 둠(다른 사용자 접근 테스트용)
insert into public.candidates (id, project_id, reaction_id, storage_path, mime_type, ext, byte_size, sha256) values
  ('cccccccc-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-000000000001/b1/c4.png', 'image/png', 'png', 10, repeat('d', 64));
insert into public.visual_options (category, label, tag) values ('mouth', '입 다묾', 'closed mouth');
reset role;

-- ── 다른 사용자 B ──
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.ok((select count(*) from public.projects) = 0, '다른 사용자는 프로젝트를 볼 수 없음');
select pg_temp.ok((select count(*) from public.reactions) = 0, '다른 사용자는 리액션을 볼 수 없음');
select pg_temp.ok((select count(*) from public.candidates) = 0, '다른 사용자는 후보를 볼 수 없음');
select pg_temp.ok((select count(*) from public.visual_options) = 0, '다른 사용자는 선택 항목을 볼 수 없음');
select pg_temp.ok((select count(*) from storage.objects) = 0, '다른 사용자는 이미지 파일 목록을 볼 수 없음');

do $$ declare n int; begin
  update public.reactions set emotion = 'hacked' where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  perform pg_temp.ok(n = 0, '다른 사용자는 리액션 수정 불가');
  delete from public.projects where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  perform pg_temp.ok(n = 0, '다른 사용자는 프로젝트 삭제 불가');
  delete from storage.objects;
  get diagnostics n = row_count;
  perform pg_temp.ok(n = 0, '다른 사용자는 이미지 삭제 불가');
  update storage.objects set name = name || 'x';
  get diagnostics n = row_count;
  perform pg_temp.ok(n = 0, '다른 사용자는 이미지 덮어쓰기 불가');
end $$;

do $$ begin
  insert into public.projects (owner_id, name) values ('11111111-1111-1111-1111-111111111111', '위장');
  raise exception 'FAIL: 남의 owner_id로 생성 허용됨';
exception when insufficient_privilege then raise notice 'PASS: 남의 owner_id로 행 생성 거부';
end $$;

-- 남의 프로젝트 ID를 알아도 그 안에 리액션을 만들 수 없음
do $$ begin
  insert into public.reactions (project_id, emotion) values ('aaaaaaaa-0000-0000-0000-000000000001', '침입');
  raise exception 'FAIL: 남의 프로젝트에 리액션 생성 허용됨';
exception when foreign_key_violation then raise notice 'PASS: 남의 프로젝트에 리액션 생성 거부';
end $$;

do $$ begin
  insert into storage.objects (bucket_id, name) values
    ('reaction-images', '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-000000000001/b1/evil.png');
  raise exception 'FAIL: 남의 폴더에 업로드 허용됨';
exception when insufficient_privilege then raise notice 'PASS: 남의 폴더에 업로드 거부';
end $$;

-- B 자신의 프로젝트에 후보 행을 만들면서 A의 이미지 경로를 가리키는 것도 거부
insert into public.projects (id, name) values ('aaaaaaaa-0000-0000-0000-0000000000b2', 'B 프로젝트');
insert into public.reactions (id, project_id) values ('bbbbbbbb-0000-0000-0000-0000000000b2', 'aaaaaaaa-0000-0000-0000-0000000000b2');
do $$ begin
  insert into public.candidates (project_id, reaction_id, storage_path, mime_type, ext, byte_size, sha256) values
    ('aaaaaaaa-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-0000000000b2',
     '11111111-1111-1111-1111-111111111111/aaaaaaaa-0000-0000-0000-000000000001/b1/c4.png', 'image/png', 'png', 1, repeat('e', 64));
  raise exception 'FAIL: 남의 이미지 경로 참조 허용됨';
exception when check_violation then raise notice 'PASS: 후보 행이 남의 이미지 경로를 가리킬 수 없음';
end $$;
reset role;

-- ── 비로그인(anon) ──
set role anon;
do $$ begin
  perform count(*) from public.projects;
  raise exception 'FAIL: anon 접근 허용됨';
exception when insufficient_privilege then raise notice 'PASS: 비로그인 사용자는 테이블 접근 불가';
end $$;
select pg_temp.ok((select count(*) from storage.objects) = 0, '비로그인 사용자는 이미지 목록을 볼 수 없음');
reset role;

-- ── A가 프로젝트 삭제 → 모두 연쇄 삭제 ──
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
delete from public.projects where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok((select count(*) from public.reactions) = 0 and (select count(*) from public.candidates) = 0, '프로젝트 삭제 시 리액션·후보 연쇄 삭제');
reset role;
\echo ALL DB TESTS PASSED
