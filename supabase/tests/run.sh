#!/usr/bin/env bash
# ローカルの PostgreSQL でスキーマを検証する。Supabase への接続は不要。
#   使い方:  ./supabase/tests/run.sh
# Supabase 固有の部分（anon ロール / storage スキーマ）は 00_supabase_stub.sql で再現している。
set -euo pipefail

# PostgreSQL は root では起動できないので、その場合は一般ユーザーで実行し直す
if [ "$(id -u)" = 0 ]; then
  RUNNER=${RUNNER:-postgres}
  if id "$RUNNER" >/dev/null 2>&1; then
    echo "root では PostgreSQL を起動できないため、$RUNNER ユーザーで実行します"
    exec su "$RUNNER" -c "$(printf '%q ' "$0" "$@")"
  fi
  echo "root 以外のユーザーで実行してください" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
WORK=$(mktemp -d)
trap 'pg_ctl -D "$WORK/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
export PATH="$PGBIN:$PATH"

initdb -D "$WORK/data" -U postgres -A trust >/dev/null
pg_ctl -D "$WORK/data" -o "-k $WORK -p 55432 -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
DB="postgresql://postgres@/postgres?host=$WORK&port=55432"

psql "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/00_supabase_stub.sql"
psql "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/schema.sql" 2>/dev/null
psql "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/schema.sql" 2>/dev/null   # 冪等性の確認
echo "スキーマ適用 OK（2回実行しても壊れない）"

OUT=$(psql "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/01_schema_test.sql" 2>&1)
echo "$OUT" | grep -E 'OK:|FAIL|ERROR|###' | sed 's/^psql:.*NOTICE:  //'
if echo "$OUT" | grep -qE 'FAIL|ERROR'; then echo "テスト失敗"; exit 1; fi
echo "すべてのテストに合格しました"
