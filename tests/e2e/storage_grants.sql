-- Supabase 플랫폼이 기본으로 주는 storage 스키마 권한(RLS가 실제 접근을 제한)
grant usage on schema storage to anon, authenticated, service_role;
grant all on all tables in schema storage to anon, authenticated, service_role;
grant all on all functions in schema storage to anon, authenticated, service_role;
grant all on all sequences in schema storage to anon, authenticated, service_role;
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
