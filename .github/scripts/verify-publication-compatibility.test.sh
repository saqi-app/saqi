#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir "$fixture/bin"
cat >"$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
output=''
bounded=false
while (($#)); do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --max-filesize) [[ $2 == 4096 ]]; bounded=true; shift 2 ;;
    --connect-timeout | --max-time | --header) shift 2 ;;
    --silent | --show-error | --fail) shift ;;
    'https://ops.saqi.app/api/rig/state?capabilities=1') shift ;;
    *) exit 90 ;;
  esac
done
[[ -n $output && $bounded == true ]]
case "$TEST_MODE" in
  valid) printf '%s' '{"ok":true,"capabilities":{"publicationCompareAndSwap":"returning-row-v1"}}' >"$output" ;;
  old) printf '%s' '{"ok":true,"state":{"checkpoint":"PRIVATE_CHECKPOINT_SENTINEL"}}' >"$output" ;;
  wrong) printf '%s' '{"ok":true,"capabilities":{"publicationCompareAndSwap":"old"}}' >"$output" ;;
  malformed) printf '%s' 'PRIVATE_CHECKPOINT_SENTINEL' >"$output" ;;
  http) echo PRIVATE_CHECKPOINT_SENTINEL >&2; exit 22 ;;
  network) echo PRIVATE_CHECKPOINT_SENTINEL >&2; exit 28 ;;
  oversized) echo PRIVATE_CHECKPOINT_SENTINEL >&2; exit 63 ;;
  *) exit 91 ;;
esac
MOCK
chmod +x "$fixture/bin/curl"

for mode in valid old wrong malformed http network oversized; do
  if PATH="$fixture/bin:$PATH" TEST_MODE=$mode \
    CF_ACCESS_CLIENT_ID=fixture-id CF_ACCESS_CLIENT_SECRET=fixture-secret \
    bash "$script_dir/verify-publication-compatibility.sh" >"$fixture/log" 2>&1; then
    [[ $mode == valid ]]
  else
    [[ $mode != valid ]]
    grep -q '^PUBLICATION_COMPATIBILITY_REQUIRED:' "$fixture/log"
  fi
  if grep -Eq 'PRIVATE_CHECKPOINT_SENTINEL|fixture-secret' "$fixture/log"; then
    echo 'Compatibility probe exposed private response or credentials' >&2
    exit 1
  fi
done
if CF_ACCESS_CLIENT_ID='' CF_ACCESS_CLIENT_SECRET='' \
  bash "$script_dir/verify-publication-compatibility.sh" >"$fixture/log" 2>&1; then
  echo 'Compatibility probe accepted missing credentials' >&2
  exit 1
fi
echo 'Publication compatibility fixtures passed'
