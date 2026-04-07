# manga-list-mangadex

[![tests](https://github.com/dcostaz/manga-list-mangadex/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/dcostaz/manga-list-mangadex/actions/workflows/tests.yml)
[![release-runtime-zip](https://github.com/dcostaz/manga-list-mangadex/actions/workflows/release-runtime-zip.yml/badge.svg?branch=main)](https://github.com/dcostaz/manga-list-mangadex/actions/workflows/release-runtime-zip.yml)
[![download-runtime-zip](https://img.shields.io/badge/download-runtime_zip-0969da?logo=github)](https://github.com/dcostaz/manga-list-mangadex/releases/download/runtime-latest/manga-list-mangadex-runtime.zip)

Runtime tracker package source for MangaDex.

This repository builds a runtime-installable zip artifact compatible with manga-list `TrackerPackageLoader`.

Latest runtime zip download (GitHub release asset):

https://github.com/dcostaz/manga-list-mangadex/releases/download/runtime-latest/manga-list-mangadex-runtime.zip

## Build

```bash
npm run build
```

Optional build flags:

```bash
node scripts/build-runtime-tracker-package.cjs --output ./dist/mangadex-runtime.zip --host-api-version 1.0.0
```

Build output contains:

1. `tracker-package.json`
2. `apiwrappers/trackerdtocontract.cjs`
3. `apiwrappers/reg-mangadex/api-wrapper-mangadex.cjs`
4. `apiwrappers/reg-mangadex/api-settings-mangadex.cjs`
5. `apiwrappers/reg-mangadex/mangadex-api-settings.json` (generated effective settings used at runtime; not an authored source file)
6. `apiwrappers/reg-mangadex/mapper-mangadex.cjs`
7. `apiwrappers/reg-mangadex/tracker-module.cjs`

Settings source of truth in this repository is split into:

1. `src/runtime/apiwrappers/reg-mangadex/mangadex-api-settings.definition.json`
2. `src/runtime/apiwrappers/reg-mangadex/mangadex-api-settings.values.json`

The build script validates and merges both source files into the runtime payload:
`apiwrappers/reg-mangadex/mangadex-api-settings.json`.

Note: Runtime manifest entrypoint `settingsFile` points to the generated effective file above,
while repository source of truth remains the definition/values pair. The definition and values source files are not bundled into the runtime zip artifact.

Contract version governance:

1. DTO contract version comes from `src/runtime/apiwrappers/trackerdtocontract.cjs` (`TRACKER_DTO_CONTRACT_VERSION`).
2. Settings contract version is centrally defined in the same file (`TRACKER_SETTINGS_CONTRACT_VERSION`).
3. Build enforces that both `mangadex-api-settings.definition.json` and `mangadex-api-settings.values.json`
	use `metadata.settingsContractVersion` matching `TRACKER_SETTINGS_CONTRACT_VERSION`.
4. Build fails fast on mismatch to prevent contract drift.

Type definitions governance:

1. Tracker-local typedefs live in `types/trackertypedefs.d.ts`.
2. Runtime classes explicitly reference these typedefs using JSDoc `import(...)` types.
3. The repository does not rely on manga-list type definition files for runtime wrapper, mapper, settings, or tracker-module contracts.

## Test

```bash
npm test
```

GitHub Actions runs the same test command on every push and pull request via:
`.github/workflows/tests.yml`.

GitHub Actions also builds and publishes the runtime zip on pushes to main via:
`.github/workflows/release-runtime-zip.yml`.

Final test suites:

1. `tests/build-runtime-tracker-package.test.cjs`
2. `tests/runtime-mapper.test.cjs`
3. `tests/runtime-settings.test.cjs`
4. `tests/runtime-wrapper-contract.test.cjs`
5. `tests/runtime-wrapper-init.test.cjs`
6. `tests/runtime-wrapper-token.test.cjs`
7. `tests/runtime-wrapper-read.test.cjs`
8. `tests/runtime-wrapper-write.test.cjs`
9. `tests/runtime-wrapper-search-cover.test.cjs`

These suites cover build/manifest compatibility, mapper normalization,
settings contracts and baseline matrix checks, wrapper lifecycle,
token lifecycle behavior, read and write orchestration flows,
and search/cover runtime behavior.