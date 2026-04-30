# Contributing

## Setup

```sh
mise install
npm ci
```

## Tests

```sh
npm run ci
```

## Releasing

```sh
git tag vX.Y.Z && git push origin vX.Y.Z
git tag -f vX vX.Y.Z && git push -f origin vX
gh release create vX.Y.Z --notes "..."
```

Consumers pin `@vX`; the floating major tag is force-moved to the latest
`vX.Y.Z`.
