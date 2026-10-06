# Saqi

[Saqi](https://saqi.app) is an Arabic poetry reader with English translations and word-by-word meanings. This repository contains the public Astro site, the Cloudflare Operations Worker, the source parser and personal Chrome collector, and the macOS rig that produces translations.

The live corpus has two application tables in Cloudflare D1: `author` and `poem`. Current Arabic text, published English output, source identity, and the small durable translation state live on those rows. The collector uses the owner's ordinary Chrome session and a local native bridge; the Mac does not keep a crawler SQLite database. Codex generation runs on the dedicated [GCP VM](RIG-VM.md), with a local macOS runner available, and can be stopped independently of collection.

## Explore the code

- [`typescript/packages/site`](typescript/packages/site) — public site, search, poem pages, and [schema explorer](https://saqi.app/docs).
- [`typescript/packages/operations`](typescript/packages/operations) — D1 migrations and the authenticated collection/publication API.
- [`typescript/packages/source-collector`](typescript/packages/source-collector) — validation and parsing of source projections.
- [`typescript/chrome/saqi-collector`](typescript/chrome/saqi-collector) — unpacked Chrome extension; credentials remain outside Chrome.
- [`typescript/scripts`](typescript/scripts) and [`macos/SaqiActivityMonitor`](macos/SaqiActivityMonitor) — local translation runner, native bridge, installers, and menu-bar status.

The [rig guide](RIG.md) covers installation, crash recovery, operational checks, backups, and rollback. Production requires your own Cloudflare resources and credentials; never commit credentials, local status files, generated poem output, or a corpus export.

## Develop

Use Node.js 24 or newer and Corepack/Yarn 4. From `typescript`:

```sh
corepack enable
yarn install --immutable
yarn build
yarn check:built
yarn test:built
```

The Chrome extension is loaded manually as an unpacked extension; see [collection setup](RIG.md#collection-in-personal-chrome). The macOS monitor is optional for web development. The deployment workflow requires an explicitly selected `main` commit and protected production credentials.

## Contributing and content rights

Issues and focused pull requests are welcome. Include a test for behavior changes that could lose a poem, duplicate a canonical identity, replay an unknown Codex call, or change public output. Keep credentials and real corpus dumps out of changes and fixtures.

The repository's [BSD Zero Clause License](LICENSE) covers the software in this repository. It does not establish permission to reuse poetry or material on external source sites. The source site [describes separate rights and reuse limits](https://www.aldiwan.net/nc-copyright); contributors should not assume that a visible poem is licensed for redistribution. Saqi's live corpus is not included in this repository or offered as a licensed dataset.
