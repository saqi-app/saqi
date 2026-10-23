#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "${script_dir}/../.." && pwd)
canary_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/saqi-route-canary.XXXXXX")
trap 'rm -rf -- "$canary_dir"' EXIT
strict=${SAQI_REQUIRE_READABLE_ROUTES:-false}
bootstrap=${SAQI_BOOTSTRAP_AUTHOR_INDEX:-false}
if [[ ("$strict" != true && "$strict" != false) || ("$bootstrap" != true && "$bootstrap" != false) ||
  -z "${CF_ACCESS_CLIENT_ID:-}" || -z "${CF_ACCESS_CLIENT_SECRET:-}" ||
  -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo 'PUBLIC_ROUTE_CANARY_CONFIGURATION_INVALID' >&2
  exit 1
fi
route_query=$(<"${script_dir}/public-route-canary.sql")
cd -- "${repo_dir}/typescript"
# Keep all CLI responses private, including errors; never dump database rows.
if ! (
  ulimit -f 128
  timeout 60 yarn workspace @saqi/operations wrangler d1 info saqi-db --json
) >"${canary_dir}/identity.json" 2>"${canary_dir}/identity.error" ||
  ! node scripts/verify-production-d1-identity.ts <"${canary_dir}/identity.json" >"${canary_dir}/identity-check.log" 2>&1; then
  echo 'PUBLIC_ROUTE_CANARY_DATABASE_IDENTITY_INVALID' >&2
  exit 1
fi
if [[ "$bootstrap" == true ]]; then
  # Bootstrap maintenance may activate routes. Complete it BEFORE querying the
  # expected destinations and never replay a mutation with an unknown result.
  curl --silent --show-error --fail-with-body --connect-timeout 10 --max-time 30 \
    --header "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
    --header "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
    --header 'Content-Type: application/json' \
    --header 'Origin: https://ops.saqi.app' \
    --header 'Sec-Fetch-Mode: cors' \
    --header 'Sec-Fetch-Site: same-origin' \
    --data '{"action":"purge-cache","bootstrapAuthorIndex":true}' \
    https://ops.saqi.app/api/rig/state |
    node scripts/verify-production-canary.ts bootstrap
fi
if ! (
  ulimit -f 128
  # Inline SQL uses D1's live query endpoint and returns the selected rows.
  # Wrangler's --file mode performs a bulk import and pauses database access.
  timeout 60 yarn workspace @saqi/operations wrangler d1 execute saqi-db --remote --json \
    --command="$route_query"
) >"${canary_dir}/routes.json" 2>"${canary_dir}/routes.error"; then
  echo 'PUBLIC_ROUTE_CANARY_METADATA_UNAVAILABLE' >&2
  exit 1
fi
author_url=$(node scripts/production-route-expectations.ts author "$strict" "${canary_dir}/routes.json")
poem_url=$(node scripts/production-route-expectations.ts poem "$strict" "${canary_dir}/routes.json")
SAQI_EXPECTED_AUTHOR_URL=$author_url SAQI_EXPECTED_POEM_URL=$poem_url \
  SAQI_BOOTSTRAP_AUTHOR_INDEX=false bash "${script_dir}/verify-production-canaries.sh"
