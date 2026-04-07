# manga-list-mangadex

Runtime tracker package source for MangaDex.

This repository builds a runtime-installable zip artifact compatible with manga-list `TrackerPackageLoader`.

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

## Test

```bash
npm test
```