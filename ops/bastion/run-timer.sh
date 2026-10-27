#!/bin/bash
set -euo pipefail
MODE=$1
cd /opt/feedflag
git pull --ff-only -q origin main || echo "[timer] pull skipped (dirty/offline) — running current checkout"
set -a; source .env; set +a
IN_WINDOW() { H=$(date -u +%H); [ "$H" -ge 12 ] || [ "$H" -lt 4 ]; }
case $MODE in
  govwatch) exec node --import tsx scripts/extract-wait-times.ts ;;
  peak)     if IN_WINDOW; then exec node --import tsx scripts/extract-wait-times.ts; else echo "peak: outside voting window (UTC hour $H)"; fi ;;
  social)   if IN_WINDOW; then exec node --import tsx src/index.ts; else echo "social: outside voting hours (UTC hour $H)"; fi ;;
  hot)      if date -u +%Y-%m-%d | grep -qE '2026-11-0[234]'; then exec node --import tsx scripts/extract-wait-times.ts; else echo "hot: not in election window"; fi ;;
esac
