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
git tag -f v1 vX.Y.Z && git push -f origin v1
```

Consumers pin `@v1`; the floating major tag is force-moved to the latest
`v1.X.Y`.
