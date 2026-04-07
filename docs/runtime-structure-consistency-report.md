# MangaDex vs MangaUpdates Runtime Structure Consistency Report

Date: 2026-04-07

## Scope
This report verifies runtime package architecture consistency between:

1. MangaDex runtime package in this repository.
2. MangaUpdates runtime package in the sibling repository.

The goal is structural consistency, not endpoint-level identity.

## Evidence Sources

MangaDex sources:
1. src/runtime/apiwrappers/reg-mangadex/tracker-module.cjs
2. src/runtime/apiwrappers/trackerdtocontract.cjs
3. tests/build-runtime-tracker-package.test.cjs
4. tests/wave0-mapper-contract.test.cjs
5. tests/wave1-runtime-baseline.test.cjs

MangaUpdates sources:
1. ../manga-list-mangaupdates/src/runtime/apiwrappers/reg-mangaupdates/tracker-module.cjs
2. ../manga-list-mangaupdates/src/runtime/apiwrappers/trackerdtocontract.cjs
3. ../manga-list-mangaupdates/tests/build-runtime-tracker-package.test.cjs
4. ../manga-list-mangaupdates/tests/wave0-mapper-contract.test.cjs
5. ../manga-list-mangaupdates/tests/wave5-search-cover-baseline.test.cjs

## Consistency Matrix

1. Wrapper, settings, mapper, tracker-module role separation: PASS
Details: both packages export WrapperClass, SettingsClass, MapperClass from tracker-module and keep DTO mapping in mapper modules.

2. Runtime build artifact structure parity: PASS
Details: both build tests assert the same seven-file zip layout pattern with tracker-specific folder and file names.

3. Generated settings file entrypoint usage: PASS
Details: both manifests point settingsFile to generated effective settings JSON, not source definition or values JSON.

4. Centralized contract governance parity: PASS
Details: both trackerdtocontract modules export TRACKER_DTO_CONTRACT_VERSION and TRACKER_SETTINGS_CONTRACT_VERSION, currently 1.0.0.

5. Mapper as canonical DTO boundary: PASS
Details: Wave 0 mapper tests in both repositories validate compact and enriched raw payload mapping into stable DTO fields.

6. Runtime seam parity for portability: PASS
Details: MangaDex runtime wrapper now uses injected adapters (httpClient/cacheAdapter/credentials callback) with in-memory fallbacks, consistent with runtime package isolation patterns used in MangaUpdates.

7. Search/cover fidelity parity baseline: PASS
Details: MangaDex runtime wrapper now enforces exact-first ranking with fuzzy fallback and normalized cover metadata/progress telemetry, matching the wave-based hardening intent established in MangaUpdates.

## Intentional Tracker-Specific Differences

1. Authentication/token endpoint shape differs by tracker API contract.
2. Endpoint templates and per-endpoint throttles differ by API surface.
3. Status value mapping differs (MangaUpdates list IDs vs MangaDex enum strings).
4. Cover/search response payload shapes differ and are normalized in mapper boundary.

These differences are intentional and do not violate runtime architecture parity.

## Host Loader Verification (Definition of Done Item 4)

Verification command executed in manga-list host repository against MangaDex runtime zip:

1. Build package: npm run build in manga-list-mangadex.
2. Install + activate package via TrackerPackageLoader.installRuntimePackage.
3. Validate package visibility and compatibility via TrackerPackageLoader.listRuntimePackages.
4. Reload package via TrackerPackageLoader.reloadRuntimePackage.
5. Remove extracted package and zip via TrackerPackageLoader.removeRuntimePackage.

Validation context snapshot:

1. `npm test` in manga-list-mangadex: 31 passing, 0 failing.
2. `npm run build` in manga-list-mangadex: runtime zip produced successfully.

Observed verification summary:

```json
{
  "install": {
    "success": true,
    "packageName": "manga-list-mangadex-runtime-1.0.0",
    "activated": true
  },
  "list": {
    "count": 1,
    "packageName": "manga-list-mangadex-runtime-1.0.0",
    "isExtracted": true,
    "hasZip": true,
    "compatibility": {
      "hostApi": true,
      "dtoContract": true
    }
  },
  "reload": {
    "discoveredCount": 1,
    "loadedServices": [
      "mangadex"
    ]
  },
  "remove": {
    "success": true,
    "packageName": "manga-list-mangadex-runtime-1.0.0",
    "runtimeRemoved": true,
    "zipRemoved": true
  }
}
```

## Conclusion

Definition of Done item 5 is satisfied for the current baseline:
Runtime structure comparison report generated against MangaUpdates and parity validated.

Definition of Done item 4 is satisfied for the current baseline:
MangaDex runtime artifact installs and loads through manga-list TrackerPackageLoader with compatible host/dto contracts and runtime module discovery.
