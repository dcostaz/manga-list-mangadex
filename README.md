# manga-list-mangadex

Runtime tracker package source for MangaDex.

This repository builds a runtime-installable zip artifact compatible with manga-list `TrackerPackageLoader`.

Current runtime wrapper port status:

1. Wave 0 mapper baseline implemented in `mapper-mangadex.cjs` with compatibility for compact and enriched raw payload shapes.
2. Wave 1 baseline implemented in `api-wrapper-mangadex.cjs` for auth/token caching, read/search transport methods, status/subscription writes, and cover discovery/download helpers.
3. Wave 2 hardening coverage added for refresh-token fallback, status cache behavior, and unfollow/updateStatus cache semantics.
4. Wave 3 fidelity coverage added for exact-first search ranking, fuzzy cover fallback, progress events, and volume-aware cover ordering.
5. Mapper boundary compatibility preserved by returning compact raw envelopes for `searchTrackersRaw`, `getSeriesByIdRaw`, and `getUserProgressRaw`.
6. Runtime seams are adapter-driven (`httpClient`, `cacheAdapter`, `onCredentialsRequired`) with in-memory fallbacks for package-level testing.

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

This runs all tests in `tests/*.test.cjs`, including Wave 1, Wave 2, and Wave 3 baseline coverage in `tests/wave1-runtime-baseline.test.cjs`.
Wave 0 mapper contract coverage is in `tests/wave0-mapper-contract.test.cjs`.

## Migration Docs

1. Port plan and wave status: `docs/mangadex-wrapper-port-plan.md`
2. Runtime consistency + host loader verification report: `docs/runtime-structure-consistency-report.md`