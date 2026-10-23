#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir "$fixture/bin"
cat >"$fixture/bin/timeout" <<'MOCK_TIMEOUT'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == 60 ]]
shift
exec "$@"
MOCK_TIMEOUT
chmod +x "$fixture/bin/timeout"
cat >"$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
output='' headers='' write_out='' url='' data='' user_agent=''
client_id=false client_secret=false json_content=false origin=false fetch_mode=false fetch_site=false
fail_mode=none connect_timeout='' max_time=''
while (($#)); do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --dump-header) headers=$2; shift 2 ;;
    --write-out) write_out=$2; shift 2 ;;
    --data) data=$2; shift 2 ;;
    --user-agent) user_agent=$2; shift 2 ;;
    --connect-timeout) connect_timeout=$2; shift 2 ;;
    --max-time) max_time=$2; shift 2 ;;
    --retry) [[ $2 == 2 ]]; shift 2 ;;
    --max-filesize) [[ $2 == 16777216 ]]; shift 2 ;;
    --header)
      case "$2" in
        'CF-Access-Client-Id: fixture-id') client_id=true ;;
        'CF-Access-Client-Secret: fixture-secret') client_secret=true ;;
        'Content-Type: application/json') json_content=true ;;
        'Origin: https://ops.saqi.app') origin=true ;;
        'Sec-Fetch-Mode: cors') fetch_mode=true ;;
        'Sec-Fetch-Site: same-origin') fetch_site=true ;;
        *) exit 90 ;;
      esac
      shift 2
      ;;
    --fail) fail_mode=empty; shift ;;
    --fail-with-body) fail_mode=body; shift ;;
    --silent | --show-error | --retry-all-errors) shift ;;
    https://*) [[ -z $url ]]; url=$1; shift ;;
    *) exit 90 ;;
  esac
done
[[ $connect_timeout == 10 && $max_time == 30 ]]
public=true
status=200
body='<html></html>'
case "$url" in
  https://saqi.app/) route=home ;;
  https://saqi.app/author/poet-abn-rumi)
    route=author
    body='<head><link rel="canonical" href="https://saqi.app/author/poet-abn-rumi"></head><h1 lang="ar">شاعر</h1>'
    ;;
  https://saqi.app/author/poet-abn-rumi/poem/5cf197dd-692d-4024-acc5-ee081560263f)
    route=poem
    body='<head><link rel="canonical" href="https://saqi.app/author/poet-abn-rumi/poem/5cf197dd-692d-4024-acc5-ee081560263f"></head><p lang="ar">بيت</p>'
    ;;
  https://saqi.app/poet/abn-rumi)
    route=author-clean; body="<head><link rel=\"canonical\" href=\"${url}\"></head><h1 lang=\"ar\">شاعر</h1>" ;;
  https://saqi.app/poet/abn-rumi/poem/first-line-0123456789abcdef | https://saqi.app/poet/abn-rumi/poem/wrong-line-0123456789abcdef)
    route=poem-clean; body="<head><link rel=\"canonical\" href=\"${url}\"></head><p lang=\"ar\">بيت</p>" ;;
  https://saqi.app/poet/abn-rumi/poem/step-*) route=poem-step; status=308 ;;
  https://saqi.app/sitemap-index.xml) route=sitemap; body='<sitemapindex/>' ;;
  https://saqi.app/author/poet-abn-rumi/page/999999) route=missing; status=404 ;;
  https://saqi.app/author/poet-abn-rumi/page/2) route=empty; status=404 ;;
  https://www.saqi.app/) route=www; status=308 ;;
  https://ops.saqi.app/api/public-sitemap)
    public=false
    route=ops-sitemap
    body='{"xml":"<sitemapindex>https://saqi.app/sitemaps/poets-1.xml</sitemapindex>"}'
    ;;
  https://ops.saqi.app/api/rig/state)
    public=false
    case "$data" in
      '') route=ops-state; body='{"ok":true,"state":{"checkpoint":"PRIVATE_PAID_STATE_SENTINEL"}}' ;;
      '{"action":"probe-cache"}') route=cache; body='{"ok":true}' ;;
      '{"action":"purge-cache","bootstrapAuthorIndex":true}')
        route=bootstrap
        body='{"ok":true,"purged":false,"cachePending":true}'
        ;;
      *) exit 90 ;;
    esac
    ;;
  https://ops.saqi.app/) public=false; route=ops-unauthenticated; status=403 ;;
  *) exit 90 ;;
esac
printf '%s\n' "$route" >>"$TEST_CALL_LOG"
if [[ $public == true ]]; then
  [[ $client_id == false && $client_secret == false && -z $data ]]
  [[ -n $output && -n $headers && $write_out == '%{http_code}' ]]
  [[ $user_agent == 'SaqiProductionCanary/1.0' ]]
elif [[ $route == ops-unauthenticated ]]; then
  [[ $client_id == false && $client_secret == false && -z $data ]]
else
  [[ $client_id == true && $client_secret == true ]]
  if [[ $route == cache || $route == bootstrap ]]; then
    [[ $json_content == true && $origin == true && $fetch_mode == true && $fetch_site == true ]]
  fi
fi

location='' duplicate_location=false
if [[ $route == www ]]; then location='https://saqi.app/'; fi
if [[ $TEST_MODE == route-* && ( $route == author || $route == poem ) && $TEST_MODE != route-stale-200 ]]; then
  status=308
  if [[ $route == author ]]; then location='https://saqi.app/poet/abn-rumi';
  else location='https://saqi.app/poet/abn-rumi/poem/first-line-0123456789abcdef'; fi
  case "$TEST_MODE" in
    route-loop) location=$url ;;
    route-foreign) location='https://foreign.test/private' ;;
    route-wrong-destination) if [[ $route == poem ]]; then location='https://saqi.app/poet/abn-rumi/poem/wrong-line-0123456789abcdef'; fi ;;
    route-duplicate) duplicate_location=true ;;
    route-overflow) if [[ $route == poem ]]; then location='https://saqi.app/poet/abn-rumi/poem/step-0'; fi ;;
  esac
elif [[ $route == poem-step ]]; then
  index=${url##*-}
  location="https://saqi.app/poet/abn-rumi/poem/step-$((index+1))"
fi
if [[ $TEST_MODE == www-wrong && $route == www ]]; then location='https://foreign.test/'; fi
mitigated='' server='SeRvEr: CloudFlare' ray='Cf-RaY: fixture-ray' content_type='Content-Type: text/html; charset=utf-8'
if [[ $public == true ]]; then
  if [[ $TEST_MODE == all-challenged ||
    ($TEST_MODE == mixed && $route == home) ||
    ($route == "$TEST_ROUTE" && $TEST_MODE == challenge*) ]]; then
    status=403
    mitigated='Cf-MiTiGaTeD: ChAlLeNgE'
    body='<html>challenge</html>'
  fi
  if [[ $route == "$TEST_ROUTE" ]]; then
    case "$TEST_MODE" in
      challenge-no-mitigation) mitigated='' ;;
      challenge-wrong-mitigation) mitigated='cf-mitigated: managed' ;;
      challenge-no-server) server='' ;;
      challenge-no-ray) ray='' ;;
      challenge-empty-ray) ray='CF-Ray:   ' ;;
      challenge-no-content-type) content_type='' ;;
      challenge-wrong-content-type) content_type='Content-Type: application/json' ;;
      unmarked) status=403 ;;
      server-error) status=500; mitigated='cf-mitigated: challenge' ;;
      redirect) status=302 ;;
      wrong-status) status=200 ;;
      transport) exit 28 ;;
      content)
        case "$route" in
          home) body='<script src="cloudflareinsights"></script>' ;;
          author) body='<html>missing canonical</html>' ;;
          poem) body='<p lang="en">missing Arabic</p>' ;;
          sitemap) body='<html>missing index</html>' ;;
          *) exit 91 ;;
        esac
        ;;
    esac
  fi
  if [[ $TEST_MODE == route-final-challenge && $route == poem-clean ]]; then
    status=403; mitigated='cf-mitigated: challenge'; body='<html>challenge</html>'
  fi
  if [[ $TEST_MODE == stale-challenge-headers && $route == author ]]; then status=403; fi
  if [[ $TEST_MODE == canonical-comment && $route == poem ]]; then
    body="<head><link rel=\"canonical\" href=\"https://saqi.app/author/wrong/poem/wrong\"><!--<link rel=\"canonical\" href=\"${url}\">--></head><p lang=\"ar\">بيت</p>"
  fi
  if [[ $TEST_MODE == mixed && $route == author ]]; then
    body='<html>missing canonical</html>'
  fi
elif [[ $route == ops-state ]]; then
  case "$TEST_MODE" in
    auth-malformed) body='PRIVATE_PAID_STATE_SENTINEL' ;;
    auth-rejected) body='{"ok":false,"state":{"checkpoint":"PRIVATE_PAID_STATE_SENTINEL"}}' ;;
    auth-challenged) status=403; mitigated='cf-mitigated: challenge' ;;
    auth-oversized) body='{"ok":true,"state":{"checkpoint":"PRIVATE_PAID_STATE_SENTINEL"}}' ;;
  esac
elif [[ $route == bootstrap && ${TEST_WRAPPER_FAILURE:-none} == bootstrap ]]; then
  body='{"ok":false,"checkpoint":"PRIVATE_PAID_STATE_SENTINEL"}'
elif [[ $route == cache && $TEST_MODE == cache-rejected ]]; then
  body='{"ok":false,"checkpoint":"PRIVATE_PAID_STATE_SENTINEL"}'
fi

if [[ -n $headers ]]; then
  {
    if [[ $TEST_MODE == stale-challenge-headers && $route == author ]]; then
      printf 'HTTP/2 403\r\ncf-mitigated: challenge\r\nserver: cloudflare\r\ncf-ray: earlier-ray\r\ncontent-type: text/html\r\n\r\n'
    fi
    printf 'HTTP/2 %s\r\n' "$status"
    if [[ -n $location ]]; then printf 'Location: %s\r\n' "$location"; fi
    if [[ $duplicate_location == true ]]; then printf 'Location: %s\r\n' "$location"; fi
    for header in "$mitigated" "$server" "$ray" "$content_type"; do
      if [[ -n $header ]]; then printf '%s\r\n' "$header"; fi
    done
    printf '\r\n'
  } >"$headers"
fi
if [[ $status -ge 400 && $fail_mode == empty ]]; then exit 22; fi
if [[ -n $output ]]; then
  printf '%s' "$body" >"$output"
else
  printf '%s' "$body"
  if [[ $route == ops-state && $TEST_MODE == auth-oversized ]]; then
    printf '%4194304s' ''
  fi
fi
if [[ -n $write_out ]]; then
  [[ $write_out == '%{http_code}' ]]
  printf '%s' "$status"
fi
if [[ $status -ge 400 && $fail_mode == body ]]; then exit 22; fi
MOCK
chmod +x "$fixture/bin/curl"

run_case() {
  local mode=$1 route=$2 expected=$3 bootstrap=${4:-false} strict=${5:-false} actual expected_calls actual_calls
  local expected_author='' expected_poem=''
  if [[ $mode == route-* ]]; then
    expected_author='https://saqi.app/poet/abn-rumi'
    expected_poem='https://saqi.app/poet/abn-rumi/poem/first-line-0123456789abcdef'
  fi
  : >"$fixture/calls"
  if PATH="$fixture/bin:$PATH" TEST_MODE=$mode TEST_ROUTE=$route \
    TEST_CALL_LOG="$fixture/calls" SAQI_BOOTSTRAP_AUTHOR_INDEX=$bootstrap SAQI_REQUIRE_READABLE_ROUTES=$strict SAQI_EXPECTED_AUTHOR_URL=$expected_author SAQI_EXPECTED_POEM_URL=$expected_poem \
    CF_ACCESS_CLIENT_ID=fixture-id CF_ACCESS_CLIENT_SECRET=fixture-secret \
    bash "$script_dir/verify-production-canaries.sh" >"$fixture/log" 2>&1; then
    actual=0
  else
    actual=1
  fi
  if [[ $actual != "$expected" ]]; then
    echo "Canary fixture result mismatch: ${mode}/${route}" >&2
    exit 1
  fi
  if grep -Eq 'PRIVATE_PAID_STATE_SENTINEL|fixture-secret|fixture-id' "$fixture/log"; then
    echo 'Canary exposed a private response or access credentials' >&2
    exit 1
  fi
  expected_calls=$'home\nauthor'
  if [[ $mode == route-* && $mode != route-loop && $mode != route-foreign && $mode != route-duplicate && $mode != route-stale-200 ]]; then expected_calls+=$'\nauthor-clean'; fi
  expected_calls+=$'\npoem'
  if [[ $mode == route-overflow ]]; then
    expected_calls+=$'\npoem-step\npoem-step\npoem-step'
  elif [[ $mode == route-* && $mode != route-loop && $mode != route-foreign && $mode != route-duplicate && $mode != route-stale-200 ]]; then expected_calls+=$'\npoem-clean'; fi
  expected_calls+=$'\nsitemap\nmissing\nempty\nwww\nops-sitemap\nops-state'
  if [[ $mode == cache-rejected ]]; then
    expected_calls+=$'\ncache'
  elif [[ $mode != auth-* ]]; then
    expected_calls+=$'\ncache'
    if [[ $bootstrap == true ]]; then
      expected_calls+=$'\nbootstrap\nauthor\npoem'
    fi
    expected_calls+=$'\nops-unauthenticated'
  fi
  actual_calls=$(<"$fixture/calls")
  if [[ $actual_calls != "$expected_calls" ]]; then
    echo "Canary fixture request sequence mismatch: ${mode}/${route}" >&2
    exit 1
  fi
  if [[ $mode == challenge || $mode == all-challenged || ($mode == route-final-challenge && $strict == false) ]]; then
    grep -q '^PUBLIC_CANARY_CHALLENGED:' "$fixture/log"
    if grep -q '^PUBLIC_CANARY_OK:' "$fixture/log"; then
      echo 'Canary claimed challenged content was verified' >&2
      exit 1
    fi
  elif [[ $expected == 0 ]]; then
    grep -q '^PUBLIC_CANARY_OK:' "$fixture/log"
  fi
  if [[ $expected == 1 && $mode != auth-* && $mode != cache-rejected ]]; then
    grep -q '^PUBLIC_CANARY_FAILED: authenticated probes finished;' "$fixture/log"
  fi
}

run_case healthy none 0
run_case healthy none 0 true
for route in home author poem sitemap missing empty www; do
  run_case challenge "$route" 0
done
run_case all-challenged none 0
run_case unmarked author 1
run_case server-error poem 1
run_case redirect sitemap 1
for route in missing empty www; do
  run_case wrong-status "$route" 1
done
for mode in challenge-no-mitigation challenge-wrong-mitigation challenge-no-server challenge-no-ray \
  challenge-empty-ray challenge-no-content-type challenge-wrong-content-type; do
  run_case "$mode" author 1
done
for route in home author poem sitemap; do
  run_case content "$route" 1
done
run_case mixed none 1
run_case transport author 1
for mode in auth-malformed auth-rejected auth-challenged auth-oversized cache-rejected; do
  run_case "$mode" none 1
done
run_case route-healthy none 0 false true
run_case route-stale-200 none 1 false true
run_case route-wrong-destination none 1 false true
run_case route-loop none 1 false true
run_case route-foreign none 1 false true
run_case route-duplicate none 1 false true
run_case route-overflow none 1 false true
run_case route-final-challenge none 0 false false
run_case route-final-challenge none 1 false true
run_case www-wrong none 1
run_case stale-challenge-headers author 1
run_case canonical-comment poem 1
echo 'Production canary fixtures passed'

cat >"$fixture/bin/yarn" <<'MOCK_YARN'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == workspace && $2 == @saqi/operations && $3 == wrangler && $4 == d1 ]]
if [[ $5 == info ]]; then
  [[ $# == 7 && $6 == saqi-db && $7 == --json ]]
  printf 'db-identity\n' >>"$TEST_CALL_LOG"
  if [[ $TEST_WRAPPER_FAILURE == identity ]]; then printf '{"uuid":"wrong","name":"saqi-db"}';
  else printf '{"uuid":"ffaae610-4dae-4d7e-bf86-8232f46ca2b5","name":"saqi-db"}'; fi
elif [[ $5 == execute ]]; then
  [[ $# == 9 && $6 == saqi-db && $7 == --remote && $8 == --json && $9 == --command=* ]]
  expected_query=$(<"$TEST_ROUTE_QUERY")
  [[ ${9#--command=} == "$expected_query" ]]
  printf 'db-routes\n' >>"$TEST_CALL_LOG"
  if [[ $TEST_WRAPPER_FAILURE == metadata ]]; then printf 'PRIVATE_PAID_STATE_SENTINEL';
  else cat "$TEST_ROUTE_METADATA"; fi
else exit 90
fi
MOCK_YARN
chmod +x "$fixture/bin/yarn"
cat >"$fixture/route-metadata.json" <<'JSON'
[{"success":true,"results":[{"poemId":"5cf197dd-692d-4024-acc5-ee081560263f","legacyAuthorSlug":"poet-abn-rumi","authorSlug":"abn-rumi","poemSlug":"first-line-0123456789abcdef","poemLanguage":"en","legacyAuthorOwned":1,"legacyPoemOwned":1,"canonicalAuthorOwned":1,"canonicalPoemOwned":1}]}]
JSON
for failure in none identity metadata bootstrap; do
  for bootstrap in false true; do
    if [[ $failure == bootstrap && $bootstrap == false ]]; then continue; fi
    : >"$fixture/calls"
    if PATH="$fixture/bin:$PATH" TEST_MODE=route-healthy TEST_ROUTE=none \
      TEST_CALL_LOG="$fixture/calls" TEST_WRAPPER_FAILURE=$failure TEST_ROUTE_METADATA="$fixture/route-metadata.json" TEST_ROUTE_QUERY="$script_dir/public-route-canary.sql" \
      CF_ACCESS_CLIENT_ID=fixture-id CF_ACCESS_CLIENT_SECRET=fixture-secret \
      CLOUDFLARE_ACCOUNT_ID=fixture-account CLOUDFLARE_API_TOKEN=fixture-token \
      SAQI_REQUIRE_READABLE_ROUTES=true SAQI_BOOTSTRAP_AUTHOR_INDEX=$bootstrap \
      bash "$script_dir/verify-production-route-canaries.sh" >"$fixture/log" 2>&1; then actual=0; else actual=1; fi
    if [[ $failure == none ]]; then
      [[ $actual == 0 ]]
      expected_calls=$'db-identity'
      if [[ $bootstrap == true ]]; then expected_calls+=$'\nbootstrap'; fi
      expected_calls+=$'\ndb-routes\nhome\nauthor\nauthor-clean\npoem\npoem-clean\nsitemap\nmissing\nempty\nwww\nops-sitemap\nops-state\ncache\nops-unauthenticated'
      grep -q '^PUBLIC_CANARY_OK:' "$fixture/log"
    else
      [[ $actual == 1 ]]
      expected_calls='db-identity'
      if [[ $failure == bootstrap ]]; then expected_calls+=$'\nbootstrap'; fi
      if [[ $failure == metadata ]]; then
        if [[ $bootstrap == true ]]; then expected_calls+=$'\nbootstrap'; fi
        expected_calls+=$'\ndb-routes'
      fi
    fi
    [[ $(<"$fixture/calls") == "$expected_calls" ]]
    if grep -Eq 'PRIVATE_PAID_STATE_SENTINEL|fixture-secret|fixture-id|fixture-token' "$fixture/log"; then
      echo 'Route canary wrapper exposed a private response or credentials' >&2
      exit 1
    fi
  done
done
echo 'Production route expectation wrapper fixtures passed'
