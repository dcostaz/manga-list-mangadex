# MangaDex Settings Reference

This document describes the tracker-specific settings declared by the `manga-list-mangadex` runtime package.

Settings contract version: **1.0.0** (declared in `src/runtime/apiwrappers/trackerdtocontract.cjs`).

---

## Three-Tier Model

| Tier | Description |
|------|-------------|
| 1 — Package defaults | Keys and standalone-viable defaults baked into this package (`mangadex-api-settings.definition.json` merged with `mangadex-api-settings.values.json`) |
| 2 — Host overrides | User-edited per-tracker values stored by the host in its override file; only `readOnly=false` keys may be written |
| 3 — Host injection | Common cross-tracker defaults from `TrackerCommonSettings` in the host; merged at init time |

Effective resolution order: Tier 2 wins over Tier 3 wins over Tier 1.

During development (unit tests, integration tests in this repo) only Tier 1 is active. Tier 1 defaults must therefore be complete and standalone-viable without Tier 3 present.

---

## Tracker Identity

| Key | Default | Notes |
|-----|---------|-------|
| `ui.label` | `MangaDex` | Display name shown in the host UI |
| `ui.icon` | `images/manga-dex.svg` | Icon path relative to the runtime package |
| `ui.credentialsTemplate` | See below | OAuth credential form schema |
| `credentials.primary` | `null` | Managed via host keychain; never stored in settings file |

### Credential fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | text | yes | MangaDex account username |
| `password` | password | yes | Account password used to request tokens |
| `clientId` | text | yes | OAuth client ID from MangaDex developer settings |
| `clientSecret` | password | yes | OAuth client secret for the MangaDex app |

---

## Authentication Architecture

MangaDex uses OAuth 2.0 / OpenID Connect. The wrapper requests access tokens via the `token` endpoint and refreshes them via the `refreshToken` endpoint using the stored client credentials.

---

## API Endpoints

All `api.*` keys are locked (`readOnly=true`, `isBasic=false`, `category=network`) and may only be changed by updating the package source and releasing a new runtime zip.

| Key | Default | Order | Description |
|-----|---------|-------|-------------|
| `api.authUrl` | `https://auth.mangadex.org/realms/mangadex/protocol/openid-connect` | 200 | OpenID Connect authentication base URL |
| `api.baseUrl` | `https://api.mangadex.org` | 210 | REST API base URL |
| `api.endpoints.token.template` | `${authUrl}/token` | 220 | OAuth token endpoint |
| `api.endpoints.refreshToken.template` | `${authUrl}/token` | 230 | OAuth refresh token endpoint |
| `api.endpoints.manga.template` | `${baseUrl}/manga` | 240 | Manga data endpoint |
| `api.endpoints.cover.template` | `${baseUrl}/cover` | 250 | Cover image endpoint |
| `api.endpoints.follow.template` | `${baseUrl}/manga/${id}/follow` | 260 | Follow manga endpoint |
| `api.endpoints.status.template` | `${baseUrl}/manga/${id}/status` | 270 | Reading status endpoint |

---

## Status Mappings

MangaDex uses **string** status values. All `statusMapping.*` keys are locked (`readOnly=true`).

| Host status | MangaDex value | Order |
|-------------|----------------|-------|
| `READING` | `"reading"` | 50 |
| `COMPLETED` | `"completed"` | 60 |
| `PLAN_TO_READ` | `"plan_to_read"` | 70 |
| `ON_HOLD` | `"on_hold"` | 80 |
| `DROPPED` | `"dropped"` | 90 |
| `RE_READING` | `"re_reading"` | 100 |

---

## Standalone Defaults for Shared Keys

These are the Tier 1 standalone defaults for the 44 shared keys required by the canonical contract. Tier 3 may override any of these at runtime for the host's cross-tracker policy.

### Connection

| Key | Default | Order |
|-----|---------|-------|
| `connection.timeout.connect` | 5000 ms | 10 |
| `connection.timeout.request` | 30000 ms | 20 |
| `connection.timeout.search` | 60000 ms | 30 |
| `connection.pool.keepAlive` | `true` | 40 |
| `connection.pool.maxSockets` | 10 | 50 |
| `connection.pool.maxFreeSockets` | 5 | 60 |
| `resilience.healthCheck.endpoint` | `"/manga"` | 70 |

### Cache

| Key | Default | Order |
|-----|---------|-------|
| `cache.enabled` | `true` | 10 |
| `cache.provider` | `"memory"` | 20 |
| `cache.ttl.default` | 3600 s | 30 |

### Rate Limit — Global

| Key | Default | Order | Notes |
|-----|---------|-------|-------|
| `rateLimit.global.enabled` | `true` | 100 | |
| `rateLimit.global.maxConcurrent` | 5 | 110 | |
| `rateLimit.global.maxPerSecond` | 5 | 120 | MangaDex documented API limit |
| `rateLimit.global.maxPerMinute` | 60 | 130 | |
| `rateLimit.global.queueSize` | 50 | 140 | |

### Rate Limit — Per Endpoint (shared)

| Key | Default | Order |
|-----|---------|-------|
| `rateLimit.perEndpoint.enabled` | `true` | 200 |
| `rateLimit.perEndpoint.defaultDelay` | 1000 ms | 210 |

### Retry

| Key | Default | Order |
|-----|---------|-------|
| `retry.enabled` | `true` | 300 |
| `retry.maxAttempts` | 3 | 310 |
| `retry.backoff.type` | `"exponential"` | 320 |
| `retry.backoff.initialDelay` | 1000 ms | 330 |
| `retry.backoff.multiplier` | 2 | 340 |
| `retry.backoff.maxDelay` | 10000 ms | 350 |
| `retry.retryableErrors` | `["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", 502, 503, 504, 429]` | 360 |

### Resilience — Circuit Breaker

| Key | Default | Order |
|-----|---------|-------|
| `resilience.circuitBreaker.enabled` | `false` (disabled until implemented) | 400 |
| `resilience.circuitBreaker.failureThreshold` | 5 | 410 |
| `resilience.circuitBreaker.failureWindow` | 10000 ms | 420 |
| `resilience.circuitBreaker.openDuration` | 30000 ms | 430 |

### Resilience — Health Check

| Key | Default | Order |
|-----|---------|-------|
| `resilience.healthCheck.enabled` | `false` (disabled until implemented) | 500 |
| `resilience.healthCheck.interval` | 60000 ms | 510 |

### Search

| Key | Default | Order |
|-----|---------|-------|
| `search.fuzzyThreshold` | 0.60 | 520 |
| `search.containmentScore` | 0.85 | 530 |
| `search.candidateLimit` | 5 | 540 |
| `search.exactMatchPolicy` | `"first"` | 550 |

---

## Tracker-Scoped Locked Keys

These keys encode MangaDex-specific cache and rate-limit topology. They are locked (`readOnly=true`, `isBasic=false`, `category=performance`, `order ≥ 600`) and may only be changed by updating the package.

### Cache TTL

| Key | Default | Order | Description |
|-----|---------|-------|-------------|
| `cache.ttl.seriesMetadata` | 86400 s (24 h) | 770 | Manga metadata — stable |
| `cache.ttl.searchResults` | 3600 s (1 h) | 780 | Search results — changes moderately |
| `cache.ttl.coverUrls` | 604800 s (7 d) | 790 | Cover image URLs — never change |
| `cache.ttl.accessToken` | 900 s (15 min) | 800 | OAuth access token — matches API expiry |
| `cache.ttl.refreshToken` | 2592000 s (30 d) | 810 | OAuth refresh token — long-lived |

### Endpoint-Coupled Rate Limits

Each key pairs with the corresponding `api.endpoints.<name>` entry.

| Key | Default | Order | Endpoint |
|-----|---------|-------|---------|
| `rateLimit.perEndpoint.token` | 0 ms | 820 | `api.endpoints.token` |
| `rateLimit.perEndpoint.refreshToken` | 0 ms | 830 | `api.endpoints.refreshToken` |
| `rateLimit.perEndpoint.manga` | 1000 ms | 840 | `api.endpoints.manga` |
| `rateLimit.perEndpoint.cover` | 1000 ms | 850 | `api.endpoints.cover` |
| `rateLimit.perEndpoint.follow` | 1000 ms | 860 | `api.endpoints.follow` |
| `rateLimit.perEndpoint.status` | 1000 ms | 870 | `api.endpoints.status` |

---

## Settings Contract Compliance

This package passes host validation with 0 errors and 0 warnings against `TRACKER_SETTINGS_CONTRACT_VERSION` 1.0.0.
