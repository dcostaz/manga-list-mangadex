# manga-list-mangadex

[![tests](https://github.com/dcostaz/manga-list-mangadex/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/dcostaz/manga-list-mangadex/actions/workflows/tests.yml)
[![release-runtime-zip](https://github.com/dcostaz/manga-list-mangadex/actions/workflows/release-runtime-zip.yml/badge.svg?branch=main)](https://github.com/dcostaz/manga-list-mangadex/actions/workflows/release-runtime-zip.yml)
[![download-runtime-zip](https://img.shields.io/badge/download-runtime_zip-0969da?logo=github)](https://github.com/dcostaz/manga-list-mangadex/releases/download/runtime-latest/manga-list-mangadex-runtime.zip)

The manga-list tracker plugin for [MangaDex](https://mangadex.org), a manga reading site with a public API, a
per-account followed list with reading statuses and ratings, and chapters it hosts itself. Contract **4.0.0**
(`docs/plugins/host-capability-contract.md` in the host repo), built on `@manga-list/plugin-sdk` in the template's
shape (`Plan-2026Q4-tracker-plugin-standardization.md`, Phase 4).

Settings reference: [docs/settings.md](docs/settings.md). What happened to each 3.x method:
[docs/nothing-lost.md](docs/nothing-lost.md).

## Shape

```
src/runtime/apiwrappers/reg-mangadex/
  client-mangadex.cjs     L4: api.mangadex.org — the password/refresh grants, the endpoints, the 100-id batches,
                          the feed's pages, the at-home servers, the HTML-edge normalizer
  mapping-mangadex.cjs    L3b: pure — MangaDex's shapes → the contract's DTOs (and the search ranking)
  plugin-mangadex.cjs     L3a: the template's generic definition (bindings by convention), plus one explicit
                          binding: summarizeEntries batched
  plugin-package.json     the manifest
  mangadex-api-settings.{definition,values}.json
  images/mangadex-icon.svg
```

Every offer the contract has for a tracker is declared and bound: `credential`, `search.query`, `search.lookup`,
`enrich`, `enrich.cover`, `sync.pull`, `sync.push`, `sync.list`, `subscribe.add`, `subscribe.remove`, `watch.entry`,
`watch.list`, `watch.summary`, `retrieve.chapterList`, `retrieve.chapterPages`.

## What MangaDex is, as this plugin relies on it

From MangaDex's API documentation and the 3.x wrapper's live-confirmed behaviour:

- **Sign-in** is OAuth2 against `auth.mangadex.org`'s realm with a *personal API client*: the password grant
  (`username`, `password`, `client_id`, `client_secret`, form-encoded) mints a 15-minute access token and a refresh
  token; the refresh grant renews the access token. The plugin renews an expired token with the refresh grant, falls
  back to the password grant when the refresh is refused, and re-signs in once (and replays once) when MangaDex
  rejects a token (401). Tokens stay in memory, per credential slot; the host never stores them.
- **Search is authenticated** (owner ruling 2026-07-17): `searchOptions.requiresCredential: true`. One
  `GET /manga?title=` with `includes[]` author, artist and cover_art carries everything a candidate needs.
- **The followed list**: `GET /manga/status` answers every followed manga's status in one call; titles come from
  `GET /manga?ids[]=` and ratings from `GET /rating?manga[]=`, 100 ids per call.
- **Reading statuses** are `reading`, `on_hold`, `plan_to_read`, `dropped`, `re_reading`, `completed` — the
  manifest's `push` and `pull` tables, one to one (the 3.x manifest's `paused` and `RE_READING → reading` were wrong,
  F9). The host resolves them; the plugin passes MangaDex's own token both ways.
- **Progress** is a rating only, an integer 1–10 (`progressAxes` `{ axis: 'rating', scale: 'integer' }`); MangaDex
  has no series-level chapter progress. The host's 0 ("cleared") is a `DELETE /rating/{id}`.
- **Subscribing** follows the manga, then sets its status; unsubscribing unfollows (already absent is success).
- **Chapters** (`/manga/{id}/feed`, 500 per page), a manga's languages (`/manga/{id}`) and pages (the at-home
  server, valid 15 minutes for its chapter, resolved on every call; full quality `data[]`) are public:
  `retrieveOptions.requiresCredential: false`, so Retrieving calls them anonymously. Chapters hosted elsewhere
  (`externalUrl`) are left out.
- **Watching**: `queryLive` and `summarizeEntries` report the manga's own state (publication status, final chapter,
  last change), never the user's list; a manga MangaDex does not return is `not_found`.

## Build and test

```bash
npm test                    # client, mapping, build, and the contract suite (fixture: tests/fixtures/mangadex-source.cjs)
npm run typecheck           # tsc --noEmit against the SDK's types
npm run check:nothing-lost  # every 3.x public method classified (docs/nothing-lost.md)
npm run build               # dist/manga-list-mangadex-runtime-<version>.zip
```

The zip holds the three files, the manifest (at the root and beside the module), the merged settings and the icon;
never the SDK, which the host places beside the plugin runtime root.

Live checks, by hand, never in CI (`tests/integration/live.manual.cjs`, read-only):

```bash
ENABLE_REAL_SEARCH_TEST=1 MDX_TEST_USERNAME=… MDX_TEST_PASSWORD=… MDX_TEST_CLIENT_ID=… MDX_TEST_CLIENT_SECRET=… \
  [MDX_TEST_SEARCH_QUERY="..."] npm run test:integration
ENABLE_REAL_LIBRARY_TEST=1 MDX_TEST_USERNAME=… (the same four) npm run test:integration
ENABLE_REAL_RETRIEVE_TEST=1 [MDX_TEST_MANGA_ID=<uuid>] npm run test:integration
```

`@manga-list/plugin-sdk` is a devDependency on `file:../manga-list-plugin-sdk` (with `install-links=true`) until the
SDK repository has a remote; the GitHub workflows cannot install it until then.
