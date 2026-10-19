#!/usr/bin/env bash
# 로컬 스택 주소로 앱을 빌드합니다(E2E용).
set -euo pipefail
cd "$(dirname "$0")/../.."
ANON=$(node -e "import('./tests/e2e/keys.mjs').then(m=>process.stdout.write(m.ANON_KEY))")
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_PUBLISHABLE_KEY=$ANON npx vite build --outDir "${DIST:-/tmp/nra-dist-e2e}" --emptyOutDir --logLevel warn
