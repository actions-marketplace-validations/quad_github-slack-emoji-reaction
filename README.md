# github-slack-emoji-reaction

A GitHub Action that reacts on Slack messages linking to a pull request with emoji
reflecting the PR's state — `approved` → ✅, `merged` → 🟪, etc.

Posting the PR link in Slack is treated as the implicit "review requested" signal.
The action then reacts on subsequent state changes:

| GH event                                          | Status              |
| ------------------------------------------------- | ------------------- |
| `pull_request_review.submitted` approved          | `approved`          |
| `pull_request_review.submitted` changes_requested | `changes-requested` |
| `pull_request.closed` (merged=true)               | `merged`            |
| `pull_request.closed` (merged=false)              | `closed`            |

`commented` reviews and dismissals are deliberately ignored (too noisy).

## Install

### 1. Create the Slack app from the manifest

> ⚠️ **Install this app in your own workspace; do not submit it to the Slack
> Marketplace.** Slack's 2025-05-29 rate-limit change drops `conversations.history`
> to 1 request per minute for newly-distributed Marketplace apps. Workspace-internal
> apps installed from a manifest keep the original Tier 3 (~50/min), which this
> action depends on.

1. Go to <https://api.slack.com/apps>, click **Create New App**, choose **From a manifest**.
2. Pick your workspace.
3. Paste the contents of [`manifest.yml`](./manifest.yml).
4. Install to the workspace.
5. From **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`).

### 2. Add the token as a repo secret

```
Settings → Secrets and variables → Actions → New repository secret
Name:  SLACK_TOKEN
Value: xoxb-…
```

### 3. Invite the bot to channels

In each Slack channel where reactions should appear, run:

```
/invite @github-pr-reactions
```

The action will only react in channels the bot is a member of.

### 4. Add the workflow

Create `.github/workflows/slack-emoji-reactions.yml`:

```yaml
# Posting the Slack link is itself the implicit "review requested" signal,
# so we react only on subsequent state changes — review submitted, or PR closed.
on:
  pull_request:        { types: [closed] }
  pull_request_review: { types: [submitted] }

# Per-PR group (NOT a global one): different PRs run in parallel so a slow run
# on one PR can't drop events for another.
concurrency:
  group: slack-emoji-reactions-${{ github.event.pull_request.number }}
  cancel-in-progress: false

# Defense-in-depth: this action only calls Slack, never the GitHub API.
permissions: {}

jobs:
  react:
    runs-on: ubuntu-latest
    steps:
      # Each emoji-* is optional; unset = no reaction for that status.
      - uses: substrate/github-slack-emoji-reaction@v1
        with:
          slack-token: ${{ secrets.SLACK_TOKEN }}
          emoji-approved:           white_check_mark
          emoji-changes-requested:  warning
          emoji-merged:             large_purple_square
          emoji-closed:             x
```

Emoji values are bare names — no surrounding colons. Custom emoji works too;
use the name your workspace registered.

## How it works

- On each event, the action derives a status, looks up the configured emoji,
  finds Slack messages linking to the PR (in any channel the bot is in), and
  adds the reaction.
- The first event for a PR scans channel history; subsequent events for the
  same PR hit a per-repo cache (via the GitHub Actions Cache API) and skip the
  scan entirely. A typical run drops from ~60s to ~5s in the warm case.
- `approved` and `changes-requested` are flippable: when one is applied, the
  bot removes its own opposite emoji (only its own — never anyone else's).
- All other reactions are additive. `merged` joins `approved` rather than
  replacing it; the message ends up telling the story.

## Re-runs

Re-running an old workflow run is safe by construction: when
`run_attempt > 1`, the action skips the flip-cleanup branch and only calls
`reactions.add` (idempotent). A stale re-run can't reverse a real
later state change.

## Limits and caveats

- The bot must be a member of the channel for reactions to land. `/invite`
  it explicitly.
- Only top-level messages are scanned. Thread replies are ignored.
- The discovery scan looks back 30 days. PRs whose Slack post is older than
  that won't get reactions on subsequent state changes.
- Workspaces with more than 100 bot-member channels: only the first 100 are
  scanned per run. Invite the bot deliberately to channels where it's wanted.

## Troubleshooting

The action logs structured events to the workflow log. To see "why didn't a
reaction land?":

- *Cache hit, no matches stored*: the PR has never been linked in any channel
  the bot is in. Invite the bot, post the link, then trigger an event.
- *`status … has no configured emoji; skipping`*: you didn't pass an
  `emoji-<status>` input for that status.
- *`Slack auth error: invalid_auth`*: the token is missing or revoked.
  Refresh `SLACK_TOKEN`.
- *`channels-per-run cap reached`*: bot is in more than 100 channels;
  consider reducing or splitting workflows.

For verbose Slack call logging, re-run the workflow with the secret
`ACTIONS_STEP_DEBUG = true` set on the repo.

## Development

```sh
mise install              # node 24 + act from mise.toml
node --test               # unit tests

# Integration tests via nektos/act (requires Docker).
# Replays a vendored event payload against ./action with a fake Slack token;
# asserts end-to-end wiring without touching real Slack.
./scripts/act-test.sh pull_request_closed
./scripts/act-test.sh pull_request_review_submitted
```

Inspired by [jybp/github-slack-emoji-reaction](https://github.com/jybp/github-slack-emoji-reaction);
this fork removes the channel allowlist and the always-on listener.
