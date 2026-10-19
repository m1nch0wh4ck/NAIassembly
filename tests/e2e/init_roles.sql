-- 로컬 스택용: Supabase 기본 역할 생성(supabase/postgres 이미지에 들어 있는 것과 같은 이름)
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'pw';
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login createrole noinherit password 'pw';
create role supabase_storage_admin login createrole noinherit password 'pw';
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create extension if not exists pgcrypto;
