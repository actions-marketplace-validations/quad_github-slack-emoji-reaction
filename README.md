# github-slack-emoji-reaction

Reacts on Slack messages linking to a pull request with emoji that mirror
the PR's state — `approved` → ✅, `merged` → 🟪, etc. Inspired by
[jybp/github-slack-emoji-reaction](https://github.com/jybp/github-slack-emoji-reaction).

| Event you trigger on                              | Reacts with               |
| ------------------------------------------------- | ------------------------- |
| `pull_request_review.submitted` approved          | `emoji-approved`          |
| `pull_request_review.submitted` changes_requested | `emoji-changes-requested` |
| `pull_request_review.submitted` commented         | `emoji-commented`         |
| `pull_request.closed` (merged)                    | `emoji-merged`            |
| `pull_request.closed` (not merged)                | `emoji-closed`            |

Each `emoji-*` input is optional; unset = no reaction. Review dismissals
are always ignored. `approved` ↔ `changes-requested` flip; `merged` joins
the existing reactions instead of replacing.

## Install

1. **Create the Slack app.** At <https://api.slack.com/apps>, **Create New
   App** → **From a manifest** → paste [`manifest.yml`](./manifest.yml) →
   install. Copy the **Bot User OAuth Token** (`xoxb-…`).
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
          emoji-approved:           white_check_mark
          emoji-changes-requested:  warning
          emoji-commented:          speech_balloon
          emoji-merged:             large_purple_square
          emoji-closed:             x
```

Emoji values are bare names (no `:colons:`); custom workspace emoji works.

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
