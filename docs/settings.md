# MangaDex Settings Reference

The settings the `manga-list-mangadex` runtime package declares (`mangadex-api-settings.definition.json`, values in
`mangadex-api-settings.values.json`; the build merges them into `mangadex-api-settings.json`). Settings contract
version **1.0.0** (`PLUGIN_SETTINGS_CONTRACT_VERSION` from `@manga-list/plugin-sdk`). Component name `MangaDexAPI`,
unchanged, so a user's saved overrides still apply.

The keys fall in the three sets of `Plan-2026Q4-tracker-plugin-standardization.md` Decision 5: **SDK-read** (the
SDK's `http` enforces them), **client-read** (`client-mangadex.cjs` reads them) and **host-read**. Keys the
decision deleted are gone: `cache.enabled`, `cache.provider`, `retry.retryableErrors`, `resilience.healthCheck.*`,
`ui.credentialsTemplate` (the credential fields are the manifest's `credentialOptions.fields`), the
`rateLimit.perEndpoint.<name>` duplicates of `api.endpoints.<name>.throttle`, and `statusMapping.*` (the status
tokens are the manifest's `syncOptions.statusVocabulary`; only MangaUpdates keeps a custom-list override).

---

## Host-read

| Key | Default | Notes |
|-----|---------|-------|
| `ui.label` | `MangaDex` | Display name |
| `ui.icon` | `images/mangadex-icon.svg` | The manifest's `iconPath` |
| `credentials.primary` | `null` | The Settings panel's system-credential button; the credential is kept in the host's keychain, never here |

### Credential fields (the manifest's `credentialOptions.fields`, contract §1.4)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | text | yes | MangaDex account username |
| `password` | password | yes | Account password, exchanged for tokens (password grant) |
| `client_id` | text | yes | The personal API client's id |
| `client_secret` | password | yes | The personal API client's secret |

## Client-read

### Endpoints (`readOnly`)

| Key | Default |
|-----|---------|
| `api.authUrl` | `https://auth.mangadex.org/realms/mangadex/protocol/openid-connect` |
| `api.baseUrl` | `https://api.mangadex.org` |
| `api.endpoints.token.template` | `${authUrl}/token` (password grant) |
| `api.endpoints.refreshToken.template` | `${authUrl}/token` (refresh grant) |
| `api.endpoints.manga.template` | `${baseUrl}/manga` (search, by-id batches; `/{id}` for one manga) |
| `api.endpoints.cover.template` | `${baseUrl}/cover` |
| `api.endpoints.follow.template` | `${baseUrl}/manga/${id}/follow` |
| `api.endpoints.status.template` | `${baseUrl}/manga/${id}/status` |
| `api.endpoints.statusList.template` | `${baseUrl}/manga/status` |
| `api.endpoints.rating.template` | `${baseUrl}/rating/${id}` |
| `api.endpoints.ratingList.template` | `${baseUrl}/rating` |
| `api.endpoints.feed.template` | `${baseUrl}/manga/${id}/feed` |
| `api.endpoints.atHomeServer.template` | `${baseUrl}/at-home/server/${id}` |

### Cache lifetimes (seconds)

| Key | Default | Used for |
|-----|---------|----------|
| `cache.ttl.seriesMetadata` | 86400 | A manga read (lookup, enrich, chapter languages) |
| `cache.ttl.searchResults` | 3600 | A title search |
| `cache.ttl.coverUrls` | 604800 | A manga's cover list and downloaded cover bytes |
| `cache.ttl.accessToken` | 900 | An access token's lifetime when MangaDex's answer carries no `expires_in` |
| `cache.ttl.refreshToken` | 2592000 | A refresh token's lifetime when the answer carries no `refresh_expires_in` |
| `cache.ttl.default` | 3600 | — |

Tokens are never written to the host cache: they live in the SDK's in-memory token cache, keyed by the call's
`identity`. Content is cached under the call's `scope`.

### Search

| Key | Default | Meaning |
|-----|---------|---------|
| `search.fuzzyThreshold` | 0.6 | The least similarity a non-exact row needs to be a candidate |
| `search.containmentScore` | 0.85 | The similarity of a title containing the other |
| `search.candidateLimit` | 5 | The most candidates answered |
| `search.exactMatchPolicy` | `first` | Cover search over a title and its alternates stops at the first exact match (`first`) or tries all (`highestScore`) |

## SDK-read

| Key | Default |
|-----|---------|
| `connection.timeout.connect` / `.request` / `.search` | 5000 / 30000 / 60000 ms |
| `connection.pool.keepAlive` / `.maxSockets` / `.maxFreeSockets` | `true` / 10 / 5 |
| `retry.enabled` / `.maxAttempts` | `true` / 3 |
| `retry.backoff.type` / `.initialDelay` / `.maxDelay` / `.multiplier` | `exponential` / 1000 ms / 10000 ms / 2 |
| `rateLimit.global.enabled` / `.maxConcurrent` / `.maxPerSecond` / `.maxPerMinute` / `.queueSize` | `true` / 5 / 5 / 60 / 50 |
| `rateLimit.perEndpoint.enabled` / `.defaultDelay` | `true` / 1000 ms (every endpoint without a throttle of its own) |
| `api.endpoints.<name>.throttle` | token, refreshToken 0; manga, cover, follow, status, feed, atHomeServer 1000 ms |
| `resilience.circuitBreaker.enabled` / `.failureThreshold` / `.failureWindow` / `.openDuration` | `false` / 5 / 10000 ms / 30000 ms |

The SDK enforces these on every request (the 3.x wrapper read none of them). With the defaults above, an endpoint
with no throttle of its own (`statusList`, `ratingList`, `rating`, a page download) waits `defaultDelay` between
calls, and the global limiter allows 60 calls a minute.
