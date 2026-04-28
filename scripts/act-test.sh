#!/usr/bin/env bash
# End-to-end integration check using nektos/act.
# Replays a vendored event payload against ./action and asserts the action
# wires up cleanly: input parsing, status derivation, Slack auth attempt,
# auth-error clean exit. Uses a fake bot token so no real Slack traffic.

set -euo pipefail

cd "$(dirname "$0")/.."

EVENT="${1:-pull_request_closed}"

case "$EVENT" in
  pull_request_closed)
    EVENT_NAME=pull_request
    PAYLOAD=fixtures/upstream/pull_request/closed.payload.json
    ;;
  pull_request_review_submitted)
    EVENT_NAME=pull_request_review
    PAYLOAD=fixtures/upstream/pull_request_review/submitted.payload.json
    ;;
  *)
    echo "usage: $0 [pull_request_closed|pull_request_review_submitted]" >&2
    exit 2
    ;;
esac

echo "==> running act with event=$EVENT_NAME payload=$PAYLOAD"

mise exec -- act "$EVENT_NAME" \
  -W .github/workflows/integration-act.yml \
  -e "$PAYLOAD" \
  -s SLACK_TOKEN=xoxb-fake-token-for-integration-tests \
  --pull=false \
  -P ubuntu-latest=catthehacker/ubuntu:act-latest
