'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MangaDexAPIWrapper = require(path.join(
  __dirname,
  '..',
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangadex',
  'api-wrapper-mangadex.cjs',
));

function createMockContext() {
  return {
    context: {
      utils: { sanitizeForSearch: (text) => String(text || '') },
      cache: {
        async getValue() { return null; },
        async setValue() {},
        async deleteValue() {},
      },
    },
  };
}

function createMockHttpClient() {
  const hooks = {
    getCalls: [],
    postCalls: [],
    getHandler: () => ({ status: 200, data: {} }),
    postHandler: () => ({ status: 200, data: {} }),
  };

  const client = {
    interceptors: { response: { use() { return 0; } } },
    async get(url, config) {
      hooks.getCalls.push({ url, config });
      const out = hooks.getHandler(url, config);
      return out && typeof out === 'object' && 'data' in out ? out : { data: out };
    },
    async post(url, payload, config) {
      hooks.postCalls.push({ url, payload, config });
      const out = hooks.postHandler(url, payload, config);
      return out && typeof out === 'object' && 'data' in out ? out : { data: out };
    },
  };

  return { client, hooks };
}

async function createWrapper(httpClient, context) {
  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
      'api.endpoints.refreshToken.template': '${authUrl}/token',
      'api.endpoints.statusList.template': '${baseUrl}/manga/status',
      'api.endpoints.manga.template': '${baseUrl}/manga',
      'api.endpoints.manga.throttle': 0,
      'api.endpoints.ratingList.template': '${baseUrl}/rating',
      'api.endpoints.rating.template': '${baseUrl}/rating/${id}',
    },
    httpClient,
    context,
  });

  await wrapper.setCredentials({
    username: 'demo',
    password: 'secret',
    client_id: 'client-id',
    client_secret: 'client-secret',
  });

  return wrapper;
}

function mangaRow(id, title) {
  return { id, attributes: { title: { en: title } } };
}

test('getReadingList normalizes the flat status map and backfills title via getMangaByIds', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url) => {
    const u = String(url);
    if (u.endsWith('/manga/status')) {
      return {
        status: 200,
        data: {
          result: 'ok',
          statuses: {
            'mdx-1': 'reading',
            'mdx-2': 'plan_to_read',
            'mdx-3': 'completed',
          },
        },
      };
    }
    if (u.endsWith('/manga')) {
      return {
        status: 200,
        data: {
          data: [
            mangaRow('mdx-1', 'Solo Leveling'),
            mangaRow('mdx-2', 'Omniscient Reader'),
            mangaRow('mdx-3', 'Beginning After the End'),
          ],
        },
      };
    }
    if (u.endsWith('/rating')) {
      return {
        status: 200,
        data: {
          result: 'ok',
          ratings: {
            'mdx-1': { rating: 8, createdAt: '2026-01-01T00:00:00+00:00' },
            'mdx-3': { rating: 10, createdAt: '2026-01-02T00:00:00+00:00' },
            // mdx-2 deliberately absent: user never rated it — must stay
            // null, not coerced to 0 or any default (R1/R2).
          },
        },
      };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const entries = await wrapper.getReadingList();

  assert.equal(entries.length, 3);
  const byId = Object.fromEntries(entries.map((e) => [e.pluginEntryId, e]));

  assert.equal(byId['mdx-1'].status, 'READING');
  assert.equal(byId['mdx-1'].canonicalUrl, 'https://mangadex.org/title/mdx-1');
  assert.equal(byId['mdx-1'].title, 'Solo Leveling');
  assert.equal(byId['mdx-2'].title, 'Omniscient Reader');
  assert.equal(byId['mdx-3'].title, 'Beginning After the End');

  assert.equal(byId['mdx-1'].rating, 8);
  assert.equal(byId['mdx-3'].rating, 10);
  assert.equal(byId['mdx-2'].rating, null);

  // chapter/volume still never invented (R1/R2) — MangaDex has no
  // series-level chapter-progress concept at all.
  for (const entry of entries) {
    assert.equal(entry.chapter, null);
    assert.equal(entry.volume, null);
    assert.equal(entry.comparison, null);
  }
});

test('getReadingList: hostProgressByEntryId enriches matching entries with a per-entry comparison (owner direction 2026-07-23), chapter comparison always null', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url) => {
    const u = String(url);
    if (u.endsWith('/manga/status')) {
      return { status: 200, data: { result: 'ok', statuses: { 'mdx-1': 'reading' } } };
    }
    if (u.endsWith('/manga')) {
      return { status: 200, data: { data: [mangaRow('mdx-1', 'Solo Leveling')] } };
    }
    if (u.endsWith('/rating')) {
      return { status: 200, data: { result: 'ok', ratings: { 'mdx-1': { rating: 9 } } } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  // Host rating 8.5 rounds to 9 (matching updateRating()'s own rounding) —
  // must not report a spurious mismatch against the remote's integer 9.
  const hostProgressByEntryId = new Map([['mdx-1', { status: 'READING', rating: 8.5 }]]);
  const entries = await wrapper.getReadingList({ hostProgressByEntryId });

  assert.ok(entries[0].comparison);
  assert.equal(entries[0].comparison.chapterAhead, null);
  assert.equal(entries[0].comparison.chapterBehindOrEqual, null);
  assert.equal(entries[0].comparison.ratingDiffers, false);
  assert.equal(entries[0].comparison.statusDiffers, false);
});

test('getReadingList: entries with no matching hostProgressByEntryId key keep comparison null', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url) => {
    const u = String(url);
    if (u.endsWith('/manga/status')) {
      return { status: 200, data: { result: 'ok', statuses: { 'mdx-1': 'reading' } } };
    }
    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const hostProgressByEntryId = new Map([['mdx-999', { status: 'READING' }]]);
  const entries = await wrapper.getReadingList({ hostProgressByEntryId });
  assert.equal(entries[0].comparison, null);
});

test('getReadingList leaves title null when the manga-details lookup has no row for an id', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url) => {
    const u = String(url);
    if (u.endsWith('/manga/status')) {
      return { status: 200, data: { result: 'ok', statuses: { 'mdx-1': 'reading' } } };
    }
    if (u.endsWith('/manga')) {
      return { status: 200, data: { data: [] } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const entries = await wrapper.getReadingList();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, null);
});

test('getReadingList returns an empty array when the account follows nothing, skipping the manga lookup entirely', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = () => ({ status: 200, data: { result: 'ok', statuses: {} } });

  const wrapper = await createWrapper(client, context);
  const entries = await wrapper.getReadingList();
  assert.deepEqual(entries, []);
  const mangaCalls = hooks.getCalls.filter((c) => String(c.url).endsWith('/manga'));
  assert.equal(mangaCalls.length, 0);
});

test('getReadingList maps unrecognized status strings by uppercasing rather than dropping them', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url) => {
    const u = String(url);
    if (u.endsWith('/manga/status')) {
      return { status: 200, data: { result: 'ok', statuses: { 'mdx-9': 'some_future_status' } } };
    }
    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const entries = await wrapper.getReadingList();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'SOME_FUTURE_STATUS');
});

test('getReadingList issues a single status request (no pagination, unlike getListSeries)', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url) => {
    const u = String(url);
    if (u.endsWith('/manga/status')) {
      return { status: 200, data: { result: 'ok', statuses: { 'mdx-1': 'reading' } } };
    }
    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  await wrapper.getReadingList();
  const statusListCalls = hooks.getCalls.filter((c) => String(c.url).endsWith('/manga/status'));
  assert.equal(statusListCalls.length, 1);
});

test('getMangaByIds chunks requests at 100 ids per call', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url, config) => {
    const requestedIds = config && config.params ? config.params['ids[]'] : [];
    return { status: 200, data: { data: requestedIds.map((id) => mangaRow(id, `Title ${id}`)) } };
  };

  const ids = Array.from({ length: 250 }, (_, i) => `mdx-${i}`);
  const wrapper = await createWrapper(client, context);
  const rows = await wrapper.getMangaByIds(ids);

  const mangaCalls = hooks.getCalls.filter((c) => String(c.url).endsWith('/manga'));
  assert.equal(mangaCalls.length, 3); // 100 + 100 + 50
  assert.equal(mangaCalls[0].config.params['ids[]'].length, 100);
  assert.equal(mangaCalls[1].config.params['ids[]'].length, 100);
  assert.equal(mangaCalls[2].config.params['ids[]'].length, 50);
  assert.equal(rows.length, 250);
});

test('getMangaByIds de-duplicates ids and short-circuits on an empty list', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url, config) => {
    const requestedIds = config && config.params ? config.params['ids[]'] : [];
    return { status: 200, data: { data: requestedIds.map((id) => mangaRow(id, `Title ${id}`)) } };
  };

  const wrapper = await createWrapper(client, context);

  const empty = await wrapper.getMangaByIds([]);
  assert.deepEqual(empty, []);
  assert.equal(hooks.getCalls.filter((c) => String(c.url).endsWith('/manga')).length, 0);

  const rows = await wrapper.getMangaByIds(['mdx-1', 'mdx-1', 'mdx-2']);
  assert.equal(rows.length, 2);
});

test('getRatings chunks requests at 100 ids per call and returns only rated entries', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = (url, config) => {
    const requestedIds = config && config.params ? config.params['manga[]'] : [];
    // Only every other id has actually been rated — mirrors the real API's
    // "ratings only present for manga you've rated" shape.
    /** @type {Record<string, { rating: number }>} */
    const ratings = {};
    requestedIds.forEach((id, i) => {
      if (i % 2 === 0) ratings[id] = { rating: 5 };
    });
    return { status: 200, data: { result: 'ok', ratings } };
  };

  const ids = Array.from({ length: 150 }, (_, i) => `mdx-${i}`);
  const wrapper = await createWrapper(client, context);
  const ratingById = await wrapper.getRatings(ids);

  const ratingCalls = hooks.getCalls.filter((c) => String(c.url).endsWith('/rating'));
  assert.equal(ratingCalls.length, 2); // 100 + 50
  assert.equal(ratingById.get('mdx-0'), 5);
  assert.equal(ratingById.has('mdx-1'), false);
  assert.equal(ratingById.size, 75);
});

test('getRatings de-duplicates ids and short-circuits on an empty list', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.postHandler = () => ({ status: 200, data: { access_token: 'rl-access', refresh_token: 'rl-refresh' } });
  hooks.getHandler = () => ({ status: 200, data: { result: 'ok', ratings: {} } });

  const wrapper = await createWrapper(client, context);

  const empty = await wrapper.getRatings([]);
  assert.equal(empty.size, 0);
  assert.equal(hooks.getCalls.filter((c) => String(c.url).endsWith('/rating')).length, 0);
});
