#!/usr/bin/env bash
set -euo pipefail

printf '%s' "$SAQI_PUBLIC_CACHE_PURGE_SECRET" |
  yarn workspace @saqi/site wrangler secret put SAQI_PUBLIC_CACHE_PURGE_SECRET --config dist/server/wrangler.json
