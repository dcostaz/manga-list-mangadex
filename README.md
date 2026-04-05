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
5. `apiwrappers/reg-mangadex/mapper-mangadex.cjs`
6. `apiwrappers/reg-mangadex/tracker-module.cjs`

## Test

```bash
npm test
```