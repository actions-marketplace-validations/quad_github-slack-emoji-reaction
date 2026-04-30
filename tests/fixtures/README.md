# Fixture provenance

The files under `upstream/` are vendored verbatim from [`octokit/webhooks`](https://github.com/octokit/webhooks/tree/main/payload-examples/api.github.com) at commit `76f8deb2d40c05aa72a8281eb0113dbe5e6a8495` (2026-04-10), the authoritative source GitHub maintains for example webhook payloads.

| File                                                  | Upstream values                                  |
| ----------------------------------------------------- | ------------------------------------------------ |
| `pull_request/closed.payload.json`                    | `action: closed`, `pull_request.merged: false`   |
| `pull_request/opened.payload.json`                    | `action: opened`                                 |
| `pull_request_review/submitted.payload.json`          | `action: submitted`, `review.state: commented`   |
| `pull_request_review/dismissed.payload.json`          | `action: dismissed`, `review.state: dismissed`   |

Variants the test suite covers but upstream doesn't ship as separate files (`merged=true`, `review.state: approved`, `review.state: changes_requested`) are produced by overriding a single field on the relevant upstream payload inside `index.test.js`. The override sites are explicit so the dependence on the underlying authoritative shape is clear.

Refresh with [`scripts/refresh-fixtures.sh`](../../scripts/refresh-fixtures.sh) (defaults to `main`); the script updates the SHA + date above.
