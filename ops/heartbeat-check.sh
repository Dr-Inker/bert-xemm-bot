#!/usr/bin/env bash
set -euo pipefail
HB=/var/lib/bert-xemm-bot/heartbeat
MAX_STALE_SEC=${MAX_STALE_SEC:-30}
if [[ ! -f "$HB" ]]; then echo "heartbeat missing"; exit 1; fi
AGE=$(( $(date +%s) - $(stat -c %Y "$HB") ))
if (( AGE > MAX_STALE_SEC )); then echo "heartbeat stale: ${AGE}s"; exit 2; fi
echo "heartbeat fresh: ${AGE}s"
