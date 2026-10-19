#!/usr/bin/env bash
# 로컬 Docker Postgres에서 마이그레이션과 접근 제어를 검증합니다.
set -euo pipefail
cd "$(dirname "$0")"
NAME=nra-dbtest
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME -e POSTGRES_PASSWORD=pw postgres:16-alpine >/dev/null
trap 'docker rm -f $NAME >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do docker exec $NAME pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 1
run() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" $NAME psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
run < supabase_stub.sql
run < ../../supabase/migrations/0001_init.sql
run < ../../supabase/migrations/0001_init.sql   # 두 번 실행해도 안전한지
docker exec -i $NAME psql -U postgres -v ON_ERROR_STOP=1 -q -o /dev/null < rls_test.sql 2>&1 | sed 's/^psql:<stdin>:[0-9]*: //'
