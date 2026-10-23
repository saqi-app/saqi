# Saqi

[Saqi](https://saqi.app) reads Arabic poetry with English translations and word-by-word meanings.

- [`site`](typescript/packages/site): Astro reader and search.
- [`operations`](typescript/packages/operations): Cloudflare D1 collection and publication API.
- [`source-collector`](typescript/packages/source-collector) and [Chrome extension](typescript/chrome/saqi-collector): source parsing and collection.
- [`scripts`](typescript/scripts) and [macOS monitor](macos/SaqiActivityMonitor): translation runner and status tools.

See [operations](RIG.md) for setup, deployment and recovery.

## Develop

Use the Node version in [`typescript/.nvmrc`](typescript/.nvmrc) and the pinned Yarn release. From `typescript`:

```sh
npm install --global npm@12.2.1 corepack@0.36.0
corepack enable
yarn install --immutable
yarn setup:standards
yarn build
yarn check:built
yarn test:built
```

## Contribute

Test changes that affect corpus identity, publication or paid-call recovery. Keep credentials, generated poem output and corpus exports out of Git.

Software license: [BSD Zero Clause](LICENSE).
