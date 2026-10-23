#!/usr/bin/env bash
set -euo pipefail

readonly curl_timeout_seconds=30
readonly curl_arguments=(--silent --show-error --connect-timeout 10 --max-time "$curl_timeout_seconds")
umask 077
canary_dir="$(mktemp -d)"
trap 'rm -rf -- "$canary_dir"' EXIT
validator="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../typescript/scripts" && pwd)/verify-production-canary.ts"

curl_probe() {
  local name=$1
  shift
  echo "canary: ${name}" >&2
  curl "${curl_arguments[@]}" "$@"
}

route_validator="$(dirname -- "$validator")/public-route-location.ts"

public_content_available=true
public_response_available=false
public_response_status=''
public_failed=false
public_probe() {
  local name=$1 expected=$2 url=$3 output=$4 status
  local headers="${output}.headers" _header_protocol header_status _header_reason
  public_response_available=false
  echo "canary: ${name}" >&2
  if status="$(curl "${curl_arguments[@]}" --max-filesize 16777216 --retry 2 --retry-all-errors \
    --dump-header "$headers" --output "$output" --write-out '%{http_code}' \
    --user-agent 'SaqiProductionCanary/1.0' "$url" 2>"${output}.transport-error")"; then
    if ! node "$route_validator" headers "$headers" >"${headers}.final"; then
      public_failed=true
      echo "PUBLIC_CANARY_FAILED: ${name} response headers were invalid" >&2
      return
    fi
    mv -- "${headers}.final" "$headers"
    read -r _header_protocol header_status _header_reason <"$headers"
    if [[ "$header_status" != "$status" ]]; then
      public_failed=true
      echo "PUBLIC_CANARY_FAILED: ${name} response status was inconsistent" >&2
      return
    fi
    public_response_status=$status
    if [[ "$status" == "$expected" || ("$expected" == route && ("$status" == 200 || "$status" == 308)) ]]; then
      public_response_available=true
    elif [[ "$status" == '403' ]] &&
      grep -Eiq '^cf-mitigated:[[:space:]]*challenge[[:space:]]*\r?$' "$headers" &&
      grep -Eiq '^server:[[:space:]]*cloudflare[[:space:]]*\r?$' "$headers" &&
      grep -Eiq '^cf-ray:[[:space:]]*[^[:space:]]+' "$headers" &&
      grep -Eiq '^content-type:[[:space:]]*text/html([;[:space:]]|$)' "$headers"; then
      public_content_available=false
      echo "PUBLIC_CANARY_CHALLENGED: ${name}; content remains unverified by CI" >&2
    else
      public_failed=true
      echo "PUBLIC_CANARY_FAILED: ${name} returned HTTP ${status}; expected ${expected}" >&2
    fi
  else
    public_failed=true
    echo "PUBLIC_CANARY_FAILED: ${name} transport failed" >&2
  fi
}

public_assert_contains() {
  local name=$1 pattern=$2 output=$3
  if ! grep -Fq -- "$pattern" "$output"; then
    public_failed=true
    echo "PUBLIC_CANARY_FAILED: ${name} content assertion failed" >&2
  fi
}

public_probe 'public homepage edge classification' 200 https://saqi.app/ "${canary_dir}/home.html"
if [[ "$public_response_available" == true ]] &&
  grep -Fq 'cloudflareinsights' "${canary_dir}/home.html"; then
  public_failed=true
  echo 'PUBLIC_CANARY_FAILED: public homepage unexpectedly contains Cloudflare browser analytics' >&2
fi
public_route_probe() {
  local name=$1 kind=$2 legacy=$3 output=$4 expected_url=$5
  local current=$legacy next hop previous
  local -a visited=()
  if [[ -n "$expected_url" ]] && ! expected_url=$(node "$route_validator" validate "$kind" "$expected_url"); then
    public_failed=true
    echo "PUBLIC_CANARY_FAILED: ${name} expected route metadata was invalid" >&2
    return
  fi
  if [[ "${SAQI_REQUIRE_READABLE_ROUTES:-false}" == true && (-z "$expected_url" || "$expected_url" == "$legacy") ]]; then
    public_failed=true
    echo "PUBLIC_CANARY_FAILED: ${name} allocated route metadata is required" >&2
    return
  fi
  for hop in 0 1 2 3; do
    for previous in "${visited[@]}"; do
      if [[ "$current" == "$previous" ]]; then
        public_failed=true
        echo "PUBLIC_CANARY_FAILED: ${name} redirect loop" >&2
        return
      fi
    done
    visited+=("$current")
    public_probe "$name" route "$current" "$output"
    if [[ "$public_response_available" != true ]]; then return; fi
    if [[ "$public_response_status" == 200 ]]; then
      if [[ (-n "$expected_url" && "$current" != "$expected_url") ||
        ("${SAQI_REQUIRE_READABLE_ROUTES:-false}" == true && "$hop" == 0) ]]; then
        public_failed=true
        echo "PUBLIC_CANARY_FAILED: ${name} did not resolve to the independently expected readable route" >&2
        return
      fi
      if ! node "$route_validator" canonical "$current" "$output"; then
        public_failed=true
        echo "PUBLIC_CANARY_FAILED: ${name} canonical head link was invalid" >&2
      fi
      public_assert_contains "$name" 'lang="ar"' "$output"
      return
    fi
    if [[ "$hop" == 3 ]] || ! next=$(node "$route_validator" location "$kind" "$current" "${output}.headers"); then
      public_failed=true
      echo "PUBLIC_CANARY_FAILED: ${name} redirect destination was invalid or exceeded its bound" >&2
      return
    fi
    current=$next
  done
}

probe_public_catalog_routes() {
  public_route_probe 'public author page' author https://saqi.app/author/poet-abn-rumi "${canary_dir}/author.html" "${SAQI_EXPECTED_AUTHOR_URL:-}"
  public_route_probe 'public poem page' poem https://saqi.app/author/poet-abn-rumi/poem/5cf197dd-692d-4024-acc5-ee081560263f "${canary_dir}/poem.html" "${SAQI_EXPECTED_POEM_URL:-}"
}

probe_public_catalog_routes
public_probe 'public sitemap' 200 https://saqi.app/sitemap-index.xml "${canary_dir}/sitemap.xml"
if [[ "$public_response_available" == true ]]; then
  public_assert_contains sitemap '<sitemapindex' "${canary_dir}/sitemap.xml"
fi
public_probe 'missing pagination page' 404 https://saqi.app/author/poet-abn-rumi/page/999999 "${canary_dir}/missing.html"
public_probe 'empty pagination page' 404 https://saqi.app/author/poet-abn-rumi/page/2 "${canary_dir}/empty.html"
public_probe 'canonical-host redirect' 308 https://www.saqi.app/ "${canary_dir}/www.html"
if [[ "$public_response_available" == true ]]; then
  if ! node "$route_validator" location home https://www.saqi.app/ "${canary_dir}/www.html.headers" >/dev/null; then
    public_failed=true
    echo 'PUBLIC_CANARY_FAILED: www redirect did not select the exact apex homepage' >&2
  fi
fi

access_client_id=${CF_ACCESS_CLIENT_ID:-}
access_client_secret=${CF_ACCESS_CLIENT_SECRET:-}
if [[ -z "$access_client_id" || -z "$access_client_secret" ]]; then
  echo 'authenticated publication canary credentials are required' >&2
  exit 1
fi

access_headers=(
  --header "CF-Access-Client-Id: ${access_client_id}"
  --header "CF-Access-Client-Secret: ${access_client_secret}"
)

curl_probe 'authenticated live public sitemap' --fail --retry 2 --retry-all-errors \
  "${access_headers[@]}" \
  https://ops.saqi.app/api/public-sitemap |
  node "$validator" sitemap

curl_probe 'authenticated rig state' --fail --retry 2 --retry-all-errors \
  "${access_headers[@]}" \
  https://ops.saqi.app/api/rig/state |
  node "$validator" state

curl_probe 'authenticated public cache write probe' --fail-with-body \
  "${access_headers[@]}" \
  --header 'Content-Type: application/json' \
  --header 'Origin: https://ops.saqi.app' \
  --header 'Sec-Fetch-Mode: cors' \
  --header 'Sec-Fetch-Site: same-origin' \
  --data '{"action":"probe-cache"}' \
  https://ops.saqi.app/api/rig/state |
  node "$validator" cache

if [[ "${SAQI_BOOTSTRAP_AUTHOR_INDEX:-false}" == true ]]; then
  curl_probe 'homepage cache compatibility after public deployment' --fail-with-body \
    "${access_headers[@]}" \
    --header 'Content-Type: application/json' \
    --header 'Origin: https://ops.saqi.app' \
    --header 'Sec-Fetch-Mode: cors' \
    --header 'Sec-Fetch-Site: same-origin' \
    --data '{"action":"purge-cache","bootstrapAuthorIndex":true}' \
    https://ops.saqi.app/api/rig/state |
    node "$validator" bootstrap
  # Deployment maintenance can activate routes. Verify the catalog again after
  # that mutation; the earlier public probes cannot prove its resulting URLs.
  probe_public_catalog_routes
fi

unauthenticated_status="$(curl_probe 'unauthenticated operations boundary' \
  --output /dev/null --write-out '%{http_code}' https://ops.saqi.app/)"
test "$unauthenticated_status" = '403'

if [[ "${SAQI_REQUIRE_READABLE_ROUTES:-false}" == true && "$public_content_available" != true ]]; then
  public_failed=true
  echo 'PUBLIC_CANARY_FAILED: strict route proof requires unchallenged public content' >&2
fi

if [[ "$public_failed" == true ]]; then
  echo 'PUBLIC_CANARY_FAILED: authenticated probes finished; public failures remain' >&2
  exit 1
fi

if [[ "$public_content_available" == true ]]; then
  echo 'PUBLIC_CANARY_OK: public application content and authenticated operations verified' >&2
else
  echo 'PUBLIC_CANARY_CHALLENGED: authenticated operations verified; public application content remains unverified by CI' >&2
fi
