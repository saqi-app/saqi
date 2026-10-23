#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo 'PUBLICATION_COMPATIBILITY_REQUIRED: deploy the returning-row compatibility Worker before expanding the schema' >&2
  exit 1
}

if [[ -z ${CF_ACCESS_CLIENT_ID:-} || -z ${CF_ACCESS_CLIENT_SECRET:-} ]]; then
  fail
fi

probe_dir=$(mktemp -d)
trap 'rm -rf -- "$probe_dir"' EXIT

# Old Workers can return a paid checkpoint for an unrecognized query. Keep all
# response bytes and transport diagnostics private, including on failure.
if ! curl --silent --show-error --fail --connect-timeout 10 --max-time 30 \
  --max-filesize 4096 \
  --header "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
  --output "$probe_dir/response.json" \
  'https://ops.saqi.app/api/rig/state?capabilities=1' \
  2>"$probe_dir/transport-error"; then
  fail
fi

if ! jq --exit-status \
  '. == {"ok":true,"capabilities":{"publicationCompareAndSwap":"returning-row-v1"}}' \
  "$probe_dir/response.json" >/dev/null 2>&1; then
  fail
fi

echo 'Publication compatibility verified without database access'
