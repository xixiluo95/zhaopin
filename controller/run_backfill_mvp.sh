#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p data

timestamp="$(date +%Y%m%d_%H%M%S)"
log_file="data/backfill_mvp_${timestamp}.log"

echo "[BackfillMVP] log_file=${log_file}"
echo "[BackfillMVP] started_at=$(date '+%Y-%m-%d %H:%M:%S')"

exec >>"$log_file" 2>&1

echo "[BackfillMVP] log_file=${log_file}"
echo "[BackfillMVP] started_at=$(date '+%Y-%m-%d %H:%M:%S')"

BACKFILL_IGNORE_NOT_FOUND_CACHE=1 BACKFILL_FORCE_REPLACE=1 node backfill_company_fields_to_feishu.js
