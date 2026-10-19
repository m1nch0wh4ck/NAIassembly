#!/usr/bin/env bash
# 로컬 Supabase 호환 스택(Postgres + GoTrue + PostgREST + Storage API + 게이트웨이) 실행.
# SB_DIR: gotrue·postgrest 바이너리와 storage 소스가 있는 폴더
set -euo pipefail
cd "$(dirname "$0")"
SB_DIR=${SB_DIR:?SB_DIR 필요}
LOG=${LOG_DIR:-/tmp/nra-stack}; mkdir -p "$LOG"
SECRET=$(node -e "import('./keys.mjs').then(m=>process.stdout.write(m.JWT_SECRET))")
ANON=$(node -e "import('./keys.mjs').then(m=>process.stdout.write(m.ANON_KEY))")
SERVICE=$(node -e "import('./keys.mjs').then(m=>process.stdout.write(m.SERVICE_KEY))")
docker rm -f nra-pg >/dev/null 2>&1 || true
docker run -d --name nra-pg -e POSTGRES_PASSWORD=postgres -p 54322:5432 postgres:16-alpine -c wal_level=logical >/dev/null
for i in $(seq 1 40); do docker exec nra-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker exec -i nra-pg psql -U postgres -q -v ON_ERROR_STOP=1 < init_roles.sql
DB=postgres://postgres:postgres@127.0.0.1:54322/postgres

# GoTrue (인증)
GOTRUE_DB_DRIVER=postgres DATABASE_URL="$DB?search_path=auth" GOTRUE_DB_NAMESPACE=auth \
GOTRUE_API_HOST=127.0.0.1 PORT=9999 API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1 GOTRUE_SITE_URL=http://127.0.0.1:4173 \
GOTRUE_JWT_SECRET="$SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
GOTRUE_JWT_ADMIN_ROLES=service_role GOTRUE_DISABLE_SIGNUP=true GOTRUE_MAILER_AUTOCONFIRM=true GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
GOTRUE_RATE_LIMIT_HEADER= LOG_LEVEL=warn \
  nohup "$SB_DIR/gotrue" > "$LOG/gotrue.log" 2>&1 < /dev/null &
for i in $(seq 1 40); do curl -s 127.0.0.1:9999/health >/dev/null && break; sleep 1; done

# Storage API (스토리지 스키마 마이그레이션 포함)
( cd "$SB_DIR/storage" && SERVER_HOST=127.0.0.1 SERVER_PORT=5000 SERVER_ADMIN_PORT=5001 AUTH_JWT_SECRET="$SECRET" AUTH_JWT_ALGORITHM=HS256 \
  ANON_KEY="$ANON" SERVICE_KEY="$SERVICE" DATABASE_URL="$DB" DB_INSTALL_ROLES=false DB_ANON_ROLE=anon DB_SERVICE_ROLE=service_role \
  DB_AUTHENTICATED_ROLE=authenticated DB_SUPER_USER=postgres DATABASE_SEARCH_PATH=storage TENANT_ID=stub REGION=local GLOBAL_S3_BUCKET=stub STORAGE_BACKEND=file \
  STORAGE_FILE_BACKEND_PATH="$LOG/files" FILE_STORAGE_BACKEND_PATH="$LOG/files" UPLOAD_FILE_SIZE_LIMIT=52428800 IMAGE_TRANSFORMATION_ENABLED=false \
  PG_QUEUE_ENABLE=false RATE_LIMITER_ENABLED=false LOG_LEVEL=warn REQUEST_ALLOW_X_FORWARDED_PATH=true \
  nohup node dist/start/server.js > "$LOG/storage.log" 2>&1 < /dev/null & )
for i in $(seq 1 60); do curl -s 127.0.0.1:5000/status >/dev/null && break; sleep 1; done

docker exec -i nra-pg psql -U postgres -q -v ON_ERROR_STOP=1 < storage_grants.sql
# 앱 마이그레이션 적용
docker exec -i nra-pg psql -U postgres -q -v ON_ERROR_STOP=1 -c "set client_min_messages=warning" -f - < ../../supabase/migrations/0001_init.sql

# PostgREST
PGRST_DB_URI="postgres://authenticator:pw@127.0.0.1:54322/postgres" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$SECRET" PGRST_SERVER_PORT=3000 PGRST_SERVER_HOST=127.0.0.1 PGRST_DB_USE_LEGACY_GUCS=false \
  nohup "$SB_DIR/postgrest" > "$LOG/postgrest.log" 2>&1 < /dev/null &
nohup node proxy.mjs > "$LOG/proxy.log" 2>&1 < /dev/null &
for i in $(seq 1 30); do curl -s 127.0.0.1:3000/ >/dev/null && break; sleep 1; done
echo "STACK READY  url=http://127.0.0.1:54321"
