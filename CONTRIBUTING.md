# Contributing

## Setup

```sh
mise install              # node 24.x via package.json devEngines
npm ci
```

## Tests

```sh
npm run ci                # biome check --write + node --test (incl. integration)
```

Unit tests in `index.test.js` cover the pure helpers and the dynamic
surface (`SlackClient.call` retry, pagination, `Memo.ensure` TTL,
`Reactor` flip cleanup, etc.) via a scripted fetch shim.

`integration.test.js` spawns `node index.js` the way GHA does
(`GITHUB_EVENT_*` + `INPUT_*` env vars, vendored fixture payload, fake
token) and asserts the action reaches Slack auth and exits 1 with the
formatted error message. Covers the wiring unit tests can't reach: the
top-level catch, FatalError → exit 1, INPUT_* env reading.

## Fixtures

Webhook payloads under `fixtures/upstream/` are vendored verbatim from
[`octokit/webhooks`](https://github.com/octokit/webhooks) at a pinned
commit. See `fixtures/SOURCE.md` for the pin and refresh recipe.

## Code shape

`index.js` is a single file, organized:

- **Constants** — Slack endpoint, status names, error sets, caps and TTLs.
- **Pure helpers** — `deriveStatus`, `prContext` and module-private URL
  helpers (`tokenizeAngles`, `urlsFromMessage`, `matchesPullUrl` etc.).
- **`FatalError`** — operator-fixable errors thrown with pre-built
  messages; caught at the top level. `FatalError.notNull(v, msg)` for
  required-input checks.
- **`SlackClient`** — `call` with self-pacing, 429 retry, inline
  auth-error detection, and `paginate(method, params, {maxPages})` as
  an async-iterable cursor walker.
- **`CacheClient`** — restore/save against the GHA Cache v1 API.
- **`Memo`** — keyed `{value, refreshedAt}` cells with TTL-aware
  `ensure`, `evictOlderThan`, `evictOldestPast`. Used for both memoized
  I/O and the per-PR match map.
- **`Reactor`** — the per-run pipeline: bundles the four deps once and
  exposes `run()`. Discovery + reaction are private.
- **`readJob`** + **`main`** — read env/payload into a job spec, then
  drive sweep → reactor → save.

The action runs on `node24` in production. Pure-JS, no runtime deps.

## Releasing

Tag a version (`vX.Y.Z`) and push. The floating major tag (`v1`) is moved
manually to point at the latest `v1.X.Y`.

## Inspiration

Inspired by [jybp/github-slack-emoji-reaction](https://github.com/jybp/github-slack-emoji-reaction);
this fork drops the channel allowlist and the always-on listener.
