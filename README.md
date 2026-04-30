# github-slack-emoji-reaction

Reacts on Slack messages linking to a pull request with emoji that mirror
the PR's state — `approved` → ✅, `merged` → 🟪, etc. Inspired by
[jybp/github-slack-emoji-reaction](https://github.com/jybp/github-slack-emoji-reaction).

| Event you trigger on                              | Input                     | Default                |
| ------------------------------------------------- | ------------------------- | ---------------------- |
| `pull_request_review.submitted` approved          | `emoji-approved`          | `white_check_mark`     |
| `pull_request_review.submitted` changes_requested | `emoji-changes-requested` | `warning`              |
| `pull_request_review.submitted` commented         | `emoji-commented`         | `speech_balloon`       |
| `pull_request.closed` (merged)                    | `emoji-merged`            | `large_purple_square`  |
| `pull_request.closed` (not merged)                | `emoji-closed`            | `x`                    |

Set any input to `""` to disable that status. Review dismissals are always
ignored. `approved` ↔ `changes-requested` flip; `merged` joins the existing
reactions instead of replacing.

For PR-themed custom emoji (e.g. GitHub's actual review icons), see
[22a/slack-github-emoji](https://github.com/22a/slack-github-emoji).

## Install

1. **Create the Slack app:**
   1. Go to <https://api.slack.com/apps>.
   2. Click **Create New App** → **From a manifest**.
   3. Pick your workspace.
   4. Paste [`manifest.yml`](./manifest.yml) and install.
   5. From **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`).
2. **Add the token** as the repo secret `SLACK_TOKEN`
   (**Settings → Secrets and variables → Actions**).
3. **Invite the bot** in each channel where reactions should appear:
   `/invite @github-pr-reactions`. Reactions only appear in member channels.
4. **Add the workflow** at `.github/workflows/slack-emoji-reactions.yml`:

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
      - uses: quad/github-slack-emoji-reaction@v1
        with:
          slack-token: ${{ secrets.SLACK_TOKEN }}
```

Override any of the `emoji-*` inputs to use custom workspace emoji
(bare names, no `:colons:`).

> ⚠️ **Install in your own workspace; do not submit to the Slack Marketplace.**
> Slack rate-limits `conversations.history` to 1 request/minute for newly
> distributed Marketplace apps. Workspace-internal apps keep the standard
> ~50/minute, which this action depends on.

## Limits

- Top-level messages only (thread replies aren't scanned).
- 30-day lookback. PRs whose Slack post is older won't get reactions on
  later state changes.
- Up to 100 bot-member channels and 50 reactions per event; the rest carry
  over to the next event for the same PR.

## Troubleshooting

Check the workflow log. The action is silent on the happy path; warnings
and errors print as GHA annotations. Set the repo secret
`ACTIONS_STEP_DEBUG=true` for verbose output.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
