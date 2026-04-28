# github-slack-emoji-reaction

Reacts on Slack messages linking to a pull request with emoji that mirror the
PR's state — `approved` → ✅, `merged` → 🟪, etc.

| Event you trigger on                              | Reacts with             |
| ------------------------------------------------- | ----------------------- |
| `pull_request_review.submitted` approved          | `emoji-approved`        |
| `pull_request_review.submitted` changes_requested | `emoji-changes-requested` |
| `pull_request.closed` (merged)                    | `emoji-merged`          |
| `pull_request.closed` (not merged)                | `emoji-closed`          |

Comment-only reviews and review dismissals are ignored.

## Install

### 1. Create the Slack app

Go to <https://api.slack.com/apps>, **Create New App** → **From a manifest**,
pick your workspace, paste [`manifest.yml`](./manifest.yml), install. From
**OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`).

> ⚠️ **Install in your own workspace; do not submit to the Slack Marketplace.**
> Slack rate-limits `conversations.history` to 1 request/minute for newly
> distributed Marketplace apps. Workspace-internal apps keep the standard
> ~50/minute, which this action depends on.

### 2. Add the token

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**, name `SLACK_TOKEN`, value the `xoxb-…` token.

### 3. Invite the bot

In each Slack channel where reactions should appear:

```
/invite @github-pr-reactions
```

Reactions only appear in channels the bot is a member of.

### 4. Add the workflow

Create `.github/workflows/slack-emoji-reactions.yml`:

```yaml
on:
  pull_request:        { types: [closed] }
  pull_request_review: { types: [submitted] }

concurrency:
  group: slack-emoji-reactions-${{ github.event.pull_request.number }}
  cancel-in-progress: false

permissions: {}

jobs:
  react:
    runs-on: ubuntu-latest
    steps:
      - uses: substrate/github-slack-emoji-reaction@v1
        with:
          slack-token: ${{ secrets.SLACK_TOKEN }}
          emoji-approved:           white_check_mark
          emoji-changes-requested:  warning
          emoji-merged:             large_purple_square
          emoji-closed:             x
```

Emoji values are bare names (no `:colons:`). Custom emoji works too — use the
name registered in your workspace. Each `emoji-*` input is optional; an unset
status is a no-op.

## What to expect

- The bot reacts to the most recent message in each channel that contains a
  link to the PR. If the same PR is posted in multiple channels the bot is in,
  each gets a reaction.
- `approved` and `changes-requested` flip back and forth: when one applies,
  the bot removes its own opposite reaction (never anyone else's).
- `merged` is additive — it joins `approved`/`changes-requested` rather than
  replacing them, so a merged PR's message tells the whole story.
- Re-running an old workflow is safe; the bot won't reverse a later real
  state change.

## Limits

- Only top-level messages are scanned (thread replies are not).
- The bot looks back 30 days. PRs whose Slack post is older won't get
  reactions on subsequent state changes.
- Up to 100 bot-member channels per run; invite the bot deliberately to
  channels where it's wanted.

## Troubleshooting

If a reaction doesn't appear, check the workflow run log. The action only
emits output when something needs your attention:

| Message                                              | What it means                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `slack-token is missing`                             | Set the `SLACK_TOKEN` secret. (Fork PRs run with empty secrets — that's expected and silent.) |
| `Slack auth error: invalid_auth`                     | Token is wrong or revoked. Generate a fresh one and update the secret. |
| `slack <method> ratelimited`                         | The workspace is hitting Slack's per-method rate cap; the action retries automatically. Frequent occurrences suggest reducing workflow trigger frequency. |
| `conversations.history <id>(<name>): <error>`        | A specific channel failed to scan. Often `channel_not_found` after a channel is archived. |
| `reactions-per-run cap … kept in cache for next run` | More than 50 messages link to this PR; the bot will catch up over subsequent events. |

For deeper debugging, set the repo secret `ACTIONS_STEP_DEBUG` to `true` and
re-run the workflow.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
