#!/usr/bin/env bash
cd "$(dirname "$0")"
SECRET=$(node -e "import('./keys.mjs').then(m=>process.stdout.write(m.JWT_SECRET))"); ANON=$(node -e "import('./keys.mjs').then(m=>process.stdout.write(m.ANON_KEY))"); SERVICE=$(node -e "import('./keys.mjs').then(m=>process.stdout.write(m.SERVICE_KEY))")
LOG=${LOG_DIR:-/tmp/nra-stack}; DB=postgres://postgres:postgres@127.0.0.1:54322/postgres
cd "$SB_DIR/storage" && SERVER_HOST=127.0.0.1 SERVER_PORT=5000 SERVER_ADMIN_PORT=5001 AUTH_JWT_SECRET="$SECRET" AUTH_JWT_ALGORITHM=HS256 \
  ANON_KEY="$ANON" SERVICE_KEY="$SERVICE" DATABASE_URL="$DB" DB_INSTALL_ROLES=false DB_ANON_ROLE=anon DB_SERVICE_ROLE=service_role \
  DB_AUTHENTICATED_ROLE=authenticated DB_SUPER_USER=postgres DATABASE_SEARCH_PATH=storage TENANT_ID=stub REGION=local GLOBAL_S3_BUCKET=stub STORAGE_BACKEND=file \
  STORAGE_FILE_BACKEND_PATH="$LOG/files" FILE_STORAGE_BACKEND_PATH="$LOG/files" UPLOAD_FILE_SIZE_LIMIT=52428800 IMAGE_TRANSFORMATION_ENABLED=false \
  PG_QUEUE_ENABLE=false RATE_LIMITER_ENABLED=false LOG_LEVEL=warn \
  nohup node dist/start/server.js > "$LOG/storage.log" 2>&1 < /dev/null &
