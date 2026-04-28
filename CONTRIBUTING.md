# Contributing

## Setup

```sh
mise install              # node 24 + act from mise.toml
npm ci
```

## Tests

```sh
npm test                  # biome check + node --test
npm run lint              # biome only
npm run format            # biome with --write
```

44 unit tests cover the pure helpers (`deriveStatus`, `prContext`,
`matchesPullUrl`, `urlsFromMessage`, `tokenizeAngles`) and the dynamic
surface (`SlackClient.call` retry, `ensureChannels` pagination,
`discoverMatches` scan + caps, `ensureBotUserId` auth, `reactToMatch` flip
cleanup with various bot-id and re-run permutations) via a scripted fetch
shim.

## Integration tests

`scripts/act-test.sh` replays a vendored event payload against the local
action via [nektos/act](https://github.com/nektos/act). Uses a fake Slack
token so no real Slack traffic happens — it asserts the action's wiring
end-to-end (input parsing, status derivation, Slack auth attempt,
auth-error clean exit). Requires Docker.

```sh
./scripts/act-test.sh pull_request_closed
./scripts/act-test.sh pull_request_review_submitted
```

## Fixtures

Webhook payloads under `fixtures/upstream/` are vendored verbatim from
[`octokit/webhooks`](https://github.com/octokit/webhooks) at a pinned
commit. See `fixtures/SOURCE.md` for the pin and refresh recipe.

## Code shape

`index.js` is a single file, organized:

- **Constants** — Slack endpoint, status names, error sets, caps and TTLs.
- **Pure helpers** — `sweepStale`, `capByLru`, `keepsMatch`, `input`, etc.
- **URL + event helpers** — `tokenizeAngles`, `urlsFromMessage`,
  `matchesPullUrl` (URLPattern-based), `deriveStatus`, `prContext`.
- **`AuthError`** + `checkAuth`.
- **`SlackClient`** — call with self-pacing + 429 retry.
- **`CacheClient`** — restore/save against the GHA Cache v1 API.
- **State + slack ops** — `ensureBotUserId`, `ensureChannels`,
  `discoverMatches`, `reactToMatch`. These mutate `state` (the JSON we
  serialize to the cache) but otherwise compose cleanly.
- **`main()`** — the entrypoint; reads the event payload, runs the
  validation guards, drives discovery + reaction + save.

The action runs on `node24` in production. Pure-JS, no runtime deps.

## Releasing

Tag a version (`vX.Y.Z`) and push. The floating major tag (`v1`) is moved
manually to point at the latest `v1.X.Y`.

## Inspiration

Inspired by [jybp/github-slack-emoji-reaction](https://github.com/jybp/github-slack-emoji-reaction);
this fork drops the channel allowlist and the always-on listener.
