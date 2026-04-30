#!/usr/bin/env bash
# Refresh tests/fixtures/upstream/ from octokit/webhooks at the given SHA.
# Usage: scripts/refresh-fixtures.sh <sha>
# After refresh, update SHA + date in tests/fixtures/SOURCE.md.

set -euo pipefail

if [ $# -ne 1 ]; then
	echo "usage: $0 <sha>" >&2
	exit 2
fi

sha=$1
root=$(git rev-parse --show-toplevel)
out="$root/tests/fixtures/upstream"

cd "$out"
for f in $(find . -type f -name '*.payload.json' | sed 's|^\./||'); do
	echo "fetching $f"
	gh api "repos/octokit/webhooks/contents/payload-examples/api.github.com/$f?ref=$sha" \
		--jq '.content' | base64 -d > "$f"
done

echo "done. update SHA + date in tests/fixtures/SOURCE.md"
