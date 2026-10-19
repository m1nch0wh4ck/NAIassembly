-- 리액션 작업실: 데이터베이스·저장소 초기 설정
-- Supabase 대시보드 → SQL Editor에 전체를 붙여넣고 Run 하세요. 여러 번 실행해도 안전하도록 작성했습니다.
-- 모든 행은 owner_id = auth.uid() 인 사용자만 읽고 쓸 수 있습니다(RLS).

-- ───────────────────────────── 테이블 ─────────────────────────────

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 200),
  character_name text not null default '' check (char_length(character_name) <= 200),
  memo text not null default '' check (char_length(memo) <= 20000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table if not exists public.reactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  project_id uuid not null,
  sort_order double precision not null default 0,
  emotion text not null default '' check (char_length(emotion) <= 200),
  expression text not null default '' check (char_length(expression) <= 5000),
  visual jsonb not null default '[]'::jsonb check (jsonb_typeof(visual) = 'array'),
  tags text not null default '' check (char_length(tags) <= 20000),
  tags_auto text not null default '' check (char_length(tags_auto) <= 20000),
  keyword text not null default '' check (char_length(keyword) <= 500),
  filename text not null default '' check (char_length(filename) <= 300),
  memo text not null default '' check (char_length(memo) <= 20000),
  status text not null default 'todo' check (status in ('todo', 'generated', 'rework', 'adopted')),
  adopted_candidate_id uuid,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  unique (id, project_id, owner_id),
  foreign key (project_id, owner_id) references public.projects (id, owner_id) on delete cascade,
  -- '채택' 상태와 채택 이미지는 항상 함께 존재합니다.
  constraint reactions_adopted_consistency check ((status = 'adopted') = (adopted_candidate_id is not null))
);

create table if not exists public.candidates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  project_id uuid not null,
  reaction_id uuid not null,
  storage_path text not null unique,
  thumb_path text,
  original_name text not null default '' check (char_length(original_name) <= 500),
  mime_type text not null,
  ext text not null check (ext ~ '^[a-z0-9]{1,8}$'),
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer,
  height integer,
  memo text not null default '' check (char_length(memo) <= 5000),
  created_at timestamptz not null default now(),
  unique (id, reaction_id),
  -- 후보는 같은 소유자의 같은 프로젝트에 속한 리액션에만 붙을 수 있습니다.
  foreign key (reaction_id, project_id, owner_id) references public.reactions (id, project_id, owner_id) on delete cascade,
  -- 저장소 경로의 첫 폴더는 반드시 소유자 ID입니다.
  check (split_part(storage_path, '/', 1) = owner_id::text),
  check (thumb_path is null or split_part(thumb_path, '/', 1) = owner_id::text)
);

-- 채택 이미지는 반드시 그 리액션의 후보여야 합니다.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reactions_adopted_candidate_fk') then
    alter table public.reactions
      add constraint reactions_adopted_candidate_fk
      foreign key (adopted_candidate_id, id) references public.candidates (id, reaction_id);
  end if;
end $$;

-- 재사용 가능한 표정·몸짓 선택 항목(사용자별 라이브러리)
create table if not exists public.visual_options (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category text not null check (char_length(category) <= 50),
  label text not null default '' check (char_length(label) <= 200),
  tag text not null default '' check (char_length(tag) <= 1000),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reactions_project_idx on public.reactions (project_id, sort_order);
create index if not exists candidates_reaction_idx on public.candidates (reaction_id, created_at);
create index if not exists candidates_project_idx on public.candidates (project_id);
create index if not exists projects_owner_idx on public.projects (owner_id);
create index if not exists visual_options_owner_idx on public.visual_options (owner_id, category, sort_order);

-- ───────────────────────────── 트리거 ─────────────────────────────

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();
drop trigger if exists reactions_touch on public.reactions;
create trigger reactions_touch before update on public.reactions
  for each row execute function public.touch_updated_at();
drop trigger if exists visual_options_touch on public.visual_options;
create trigger visual_options_touch before update on public.visual_options
  for each row execute function public.touch_updated_at();

-- 리액션·후보가 바뀌면 프로젝트 수정일을 갱신합니다(버전은 바꾸지 않음).
create or replace function public.touch_project_from_child() returns trigger
language plpgsql set search_path = '' as $$
declare pid uuid;
begin
  pid := coalesce(new.project_id, old.project_id);
  update public.projects set updated_at = now() where id = pid;
  return null;
end $$;

drop trigger if exists reactions_touch_project on public.reactions;
create trigger reactions_touch_project after insert or update or delete on public.reactions
  for each row execute function public.touch_project_from_child();
drop trigger if exists candidates_touch_project on public.candidates;
create trigger candidates_touch_project after insert or update or delete on public.candidates
  for each row execute function public.touch_project_from_child();

-- 첫 이미지 등록 시 '미작업' → '생성됨'
create or replace function public.candidate_after_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.reactions
     set status = 'generated', version = version + 1
   where id = new.reaction_id and status = 'todo';
  return null;
end $$;

drop trigger if exists candidates_after_insert on public.candidates;
create trigger candidates_after_insert after insert on public.candidates
  for each row execute function public.candidate_after_insert();

-- 채택 이미지를 지우면 채택을 해제합니다.
create or replace function public.candidate_before_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.reactions
     set adopted_candidate_id = null, status = 'generated', version = version + 1
   where id = old.reaction_id and adopted_candidate_id = old.id;
  return old;
end $$;

drop trigger if exists candidates_before_delete on public.candidates;
create trigger candidates_before_delete before delete on public.candidates
  for each row execute function public.candidate_before_delete();

-- 후보가 하나도 남지 않으면 '생성됨' → '미작업'
create or replace function public.candidate_after_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.reactions r
     set status = 'todo', version = version + 1
   where r.id = old.reaction_id and r.status = 'generated'
     and not exists (select 1 from public.candidates c where c.reaction_id = old.reaction_id);
  return null;
end $$;

drop trigger if exists candidates_after_delete on public.candidates;
create trigger candidates_after_delete after delete on public.candidates
  for each row execute function public.candidate_after_delete();

-- ───────────────────────────── 접근 제어(RLS) ─────────────────────────────

alter table public.projects enable row level security;
alter table public.reactions enable row level security;
alter table public.candidates enable row level security;
alter table public.visual_options enable row level security;

revoke all on public.projects, public.reactions, public.candidates, public.visual_options from anon;
grant select, insert, update, delete on public.projects, public.reactions, public.candidates, public.visual_options to authenticated;

do $$
declare t text;
begin
  foreach t in array array['projects', 'reactions', 'candidates', 'visual_options'] loop
    execute format('drop policy if exists "owner_select" on public.%I', t);
    execute format('drop policy if exists "owner_insert" on public.%I', t);
    execute format('drop policy if exists "owner_update" on public.%I', t);
    execute format('drop policy if exists "owner_delete" on public.%I', t);
    execute format('create policy "owner_select" on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner_insert" on public.%I for insert to authenticated with check (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner_update" on public.%I for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner_delete" on public.%I for delete to authenticated using (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

-- ───────────────────────────── 이미지 저장소 ─────────────────────────────
-- 비공개 버킷. 경로는 <사용자ID>/<프로젝트ID>/<리액션ID>/<후보ID>.<확장자> 형식입니다.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reaction-images', 'reaction-images', false, 52428800,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "reaction_images_owner_select" on storage.objects;
drop policy if exists "reaction_images_owner_insert" on storage.objects;
drop policy if exists "reaction_images_owner_update" on storage.objects;
drop policy if exists "reaction_images_owner_delete" on storage.objects;

create policy "reaction_images_owner_select" on storage.objects for select to authenticated
  using (bucket_id = 'reaction-images' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "reaction_images_owner_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'reaction-images' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "reaction_images_owner_update" on storage.objects for update to authenticated
  using (bucket_id = 'reaction-images' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'reaction-images' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "reaction_images_owner_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'reaction-images' and (storage.foldername(name))[1] = (select auth.uid()::text));
