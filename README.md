# github-slack-emoji-reaction

Reacts on Slack messages linking to a pull request with emoji that mirror the PR's state — `approved` → ✅, `merged` → 🚀, etc.

Inspired by [jybp/github-slack-emoji-reaction](https://github.com/jybp/github-slack-emoji-reaction).

## Install

1. Create the Slack app:
   1. Go to <https://api.slack.com/apps>.
   2. Click **Create New App** → **From a manifest**.
   3. Pick your workspace.
   4. Paste the contents of [`manifest.yml`](./manifest.yml) and install.
   5. From **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`).
2. Add the **Bot User OAuth Token** to the Github repository you link to in Slack:
   1. Go to your repository on Github. (e.g. <https://github.com/your-org/your-repository>)
   2. Click **Settings** → **Secrets and variables** → **Actions**.
   3. Click the **New repository secret** button.
   4. Fill in **Name** with `SLACK_TOKEN` and **Secret** with the **Bot User OAuth Token** from step 1.
   5. Click **Add Secret**.
3. Add the workflow to your Github repository at `.github/workflows/slack-emoji-reactions.yml`:

   ```yaml
   name: Slack Emoji Reactions
   on:
     pull_request:        { types: [closed, reopened] }
     pull_request_review: { types: [submitted, dismissed] }

   permissions:
     pull-requests: read

   jobs:
     react:
       runs-on: ubuntu-latest
       steps:
         - uses: quad/github-slack-emoji-reaction@v2
           with:
             slack-token: ${{ secrets.SLACK_TOKEN }}
   ```

5. Invite the Slack bot to each channel where reactions should appear: `/invite @github-pr-reactions`.

## Configure

| Event you trigger on                              | Input                     | Default               |
| ------------------------------------------------- | ------------------------- | --------------------- |
| `pull_request_review.submitted` approved          | `emoji-approved`          | ✅ `white_check_mark` |
| `pull_request_review.submitted` changes_requested | `emoji-changes-requested` | ⚠️ `warning`          |
| `pull_request_review.submitted` commented         | `emoji-commented`         | 💬 `speech_balloon`   |
| `pull_request.closed` (merged)                    | `emoji-merged`            | 🚀 `rocket`           |
| `pull_request.closed` (not merged)                | `emoji-closed`            | ❌ `x`                |

Override any `emoji-*` input in the workflow `with:` block. Use bare names (no `:colons:`); custom workspace emoji works. Set an input to `""` to disable that status.

For nicer GitHub-themed Slack emoji, see [22a/slack-github-emoji](https://github.com/22a/slack-github-emoji). Once installed in your workspace:

```yaml
- uses: quad/github-slack-emoji-reaction@v2
  with:
    slack-token: ${{ secrets.SLACK_TOKEN }}
    emoji-approved: approved
    emoji-changes-requested: requested-changes
    emoji-commented: reviewed
    emoji-merged: merged
    emoji-closed: closed
```

## Limits

- ⚠️ Install the Slack app in your own workspace; do not submit to the Slack Marketplace. Marketplace apps hit a Slack rate limit that breaks this action.
- Forked PRs run without a token; the action treats this as expected and exits cleanly.
- Top-level messages only (thread replies aren't scanned).
- 30-day lookback. PRs whose Slack post is older won't get reactions on later state changes.
- Up to 100 bot-member channels and 50 reactions per run; the rest carry over to the next run for the same PR.

## Troubleshooting

Check the workflow log. The action is silent on the happy path; warnings and errors print as GHA annotations.

Set the repo secret `ACTIONS_STEP_DEBUG=true` for verbose output.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
