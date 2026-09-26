#!/usr/bin/env bash
set -euo pipefail

readonly curl_timeout_seconds=30
canary_dir="$(mktemp -d)"
trap 'rm -rf -- "$canary_dir"' EXIT

curl_probe() {
  local name=$1
  shift
  echo "canary: ${name}" >&2
  curl --silent --show-error --connect-timeout 10 \
    --max-time "$curl_timeout_seconds" "$@"
}

is_cloudflare_challenge() {
  local headers=$1
  grep -Eiq '^cf-mitigated:[[:space:]]*challenge[[:space:]]*\r?$' "$headers" \
    && grep -Eiq '^server:[[:space:]]*cloudflare[[:space:]]*\r?$' "$headers" \
    && grep -Eiq '^cf-ray:[[:space:]]*[^[:space:]]+' "$headers"
}

public_headers="${canary_dir}/public-home.headers"
public_status="$(curl_probe 'public homepage edge classification' \
  --dump-header "$public_headers" \
  --output "${canary_dir}/home.html" \
  --write-out '%{http_code}' \
  --user-agent 'SaqiProductionCanary/1.0' \
  https://saqi.app/)"

public_content_available=false
if [[ "$public_status" == '200' ]]; then
  public_content_available=true
elif [[ "$public_status" == '403' ]] \
  && is_cloudflare_challenge "$public_headers"; then
  echo 'PUBLIC_CANARY_CHALLENGED: Cloudflare challenged the public probe; continuing with authenticated canaries' >&2
else
  echo "public homepage canary returned unexpected HTTP ${public_status}" >&2
  sed -n '1,40p' "$public_headers" >&2
  exit 1
fi

if [[ "$public_content_available" == true ]]; then
  curl_probe 'public author page' --fail --retry 2 --retry-all-errors \
    --output "${canary_dir}/author.html" \
    https://saqi.app/author/poet-abn-rumi
  curl_probe 'public poem page' --fail --retry 2 --retry-all-errors \
    --output "${canary_dir}/poem.html" \
    https://saqi.app/author/poet-abn-rumi/poem/5cf197dd-692d-4024-acc5-ee081560263f
  curl_probe 'public sitemap' --fail --retry 2 --retry-all-errors \
    --output "${canary_dir}/sitemap-index.xml" \
    https://saqi.app/sitemap-index.xml

  grep -Fq 'rel="canonical" href="https://saqi.app/author/poet-abn-rumi"' \
    "${canary_dir}/author.html"
  grep -Fq 'lang="ar"' "${canary_dir}/poem.html"
  grep -Fq '<sitemapindex' "${canary_dir}/sitemap-index.xml"
  if grep -Fq 'cloudflareinsights' "${canary_dir}/home.html"; then
    echo 'public homepage unexpectedly contains Cloudflare browser analytics' >&2
    exit 1
  fi

  http_status() {
    curl_probe "$1" --output /dev/null --write-out '%{http_code}' "$2"
  }

  test "$(http_status 'missing pagination page' \
    https://saqi.app/author/poet-abn-rumi/page/999999)" = '404'
  test "$(http_status 'empty pagination page' \
    https://saqi.app/author/poet-abn-rumi/page/2)" = '404'
  test "$(http_status 'canonical-host redirect' https://www.saqi.app/)" = '308'
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
  https://ops.saqi.app/api/public-sitemap \
  | node -e 'let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const { xml } = JSON.parse(body); if (typeof xml !== "string" || !xml.includes("<sitemapindex") || !xml.includes("https://saqi.app/sitemaps/authors-1.xml")) process.exit(1); console.error("PUBLIC_SITEMAP_OK: live XML fetched from public Worker"); });'

curl_probe 'authenticated rig state' --fail --retry 2 --retry-all-errors \
  "${access_headers[@]}" \
  https://ops.saqi.app/api/rig/state \
  | node -e 'let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const parsed = JSON.parse(body); if (parsed.ok !== true || !("state" in parsed)) process.exit(1); console.error("RIG_STATE_OK: canonical D1 queue is readable"); });'

test "$(curl_probe 'unauthenticated operations boundary' \
  --output /dev/null --write-out '%{http_code}' https://ops.saqi.app/)" = '403'

if [[ "$public_content_available" == true ]]; then
  echo 'PUBLIC_CANARY_OK: public application content and authenticated operations verified' >&2
else
  echo 'PUBLIC_CANARY_CHALLENGED: authenticated operations verified; public application content remains unverified by CI' >&2
fi
