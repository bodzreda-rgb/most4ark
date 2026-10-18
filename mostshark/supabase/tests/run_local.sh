#!/usr/bin/env bash
# Runs all migrations + seed + SQL policy tests against a throw-away local Postgres.
# Usage: PGHOST=/tmp PGPORT=5433 PGUSER=postgres ./run_local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=mostshark_test
psql -v ON_ERROR_STOP=1 -d postgres -qc "drop database if exists $DB" -c "create database $DB"
P="psql -v ON_ERROR_STOP=1 -q -d $DB"
$P -f tests/00_supabase_stub.sql
for f in migrations/*.sql; do echo "== $f"; $P -f "$f"; done
$P -f seed.sql
$P -f tests/10_policy_tests.sql
echo "ALL SQL TESTS PASSED"
