#!/usr/bin/env bash
set -euo pipefail

[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$GITHUB_REF" = 'refs/heads/main'
test "$EXPECTED_SHA" = "$GITHUB_SHA"
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
git diff --exit-code
