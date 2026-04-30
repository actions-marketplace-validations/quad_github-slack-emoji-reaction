#!/usr/bin/env bash
# Refresh tests/fixtures/upstream/ from octokit/webhooks at the given ref
# (default: main), and update the pin (SHA + date) in tests/fixtures/README.md.
# Usage: scripts/refresh-fixtures.sh [ref]

set -euo pipefail

ref=${1:-main}
root=$(git rev-parse --show-toplevel)
out="$root/tests/fixtures/upstream"
readme="$root/tests/fixtures/README.md"

read -r sha date < <(
	gh api "repos/octokit/webhooks/commits/$ref" \
		--jq '[.sha, (.commit.committer.date | split("T")[0])] | @tsv'
)
echo "resolved $ref → $sha ($date)"

cd "$out"
for f in $(find . -type f -name '*.payload.json' | sed 's|^\./||'); do
	echo "fetching $f"
	gh api "repos/octokit/webhooks/contents/payload-examples/api.github.com/$f?ref=$sha" \
		--jq '.content' | base64 -d > "$f"
done

perl -i -pe "s/at commit \`[0-9a-f]{40}\` \([0-9-]{10}\)/at commit \`$sha\` ($date)/" "$readme"

echo "done"
