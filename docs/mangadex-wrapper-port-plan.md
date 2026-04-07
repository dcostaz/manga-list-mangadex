# MangaDex Runtime Wrapper Port Plan

Date: 2026-04-07

## Objective
Port MangaDex runtime wrapper from placeholder implementation to host-compatible runtime behavior using the same wave strategy and DoD used for MangaUpdates.

## Definition of Done

1. Runtime wrapper methods are implemented in wave increments with tests.
2. Mapper contract normalizes raw envelopes into stable DTOs.
3. Runtime package build and tests pass.
4. Host TrackerPackageLoader install/list/reload/remove verification succeeds.
5. Runtime structure consistency report is generated against MangaUpdates runtime package.

## Wave Status

1. Wave 0: Mapper baseline and compatibility
Status: COMPLETE
Evidence:
- tests/wave0-mapper-contract.test.cjs
- src/runtime/apiwrappers/reg-mangadex/mapper-mangadex.cjs

2. Wave 1: Runtime auth/read/write/search/cover baseline
Status: COMPLETE
Evidence:
- tests/wave1-runtime-baseline.test.cjs
- src/runtime/apiwrappers/reg-mangadex/api-wrapper-mangadex.cjs

3. Wave 2: Write-path hardening and edge cases
Status: COMPLETE
Evidence:
- tests/wave1-runtime-baseline.test.cjs (Wave 2 auth/status/write hardening cases)
- src/runtime/apiwrappers/reg-mangadex/api-wrapper-mangadex.cjs

4. Wave 3: Search/cover fidelity hardening
Status: COMPLETE
Evidence:
- tests/wave1-runtime-baseline.test.cjs (Wave 3 search/cover fidelity cases)
- src/runtime/apiwrappers/reg-mangadex/api-wrapper-mangadex.cjs

5. Wave 4: Documentation and final verification sweep
Status: COMPLETE (current baseline)
Evidence:
- docs/runtime-structure-consistency-report.md
- host TrackerPackageLoader install/list/reload/remove verification output (2026-04-07)
- npm test and npm run build green after Wave 3 updates

## Current Evidence Snapshot

1. npm test: PASS (all tests in tests/*.test.cjs).
	Latest run: 31 passing, 0 failing.
2. npm run build: PASS (runtime zip produced).
3. Host loader verification: PASS for install/list/reload/remove.
4. Consistency report: docs/runtime-structure-consistency-report.md.
