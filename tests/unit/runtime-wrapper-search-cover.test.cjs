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

function createMockContext(initialData) {
  const hooks = {
    data: new Map(Object.entries(initialData || {})),
  };

  return {
    context: {
      utils: {
        sanitizeForSearch: (text) => (typeof text === 'string' ? text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : ''),
      },
      cache: {
        async getValue(key) {
          return hooks.data.has(key) ? hooks.data.get(key) || null : null;
        },
        async setValue(key, value) {
          hooks.data.set(key, value);
        },
        async deleteValue(key) {
          hooks.data.delete(key);
        },
      },
    },
    hooks,
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
    interceptors: {
      response: {
        use() {
          return 0;
        },
      },
    },
    async get(url, config) {
      hooks.getCalls.push({ url, config });
      const out = hooks.getHandler(url, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
    },
    async post(url, payload, config) {
      hooks.postCalls.push({ url, payload, config });
      const out = hooks.postHandler(url, payload, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
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
      'api.endpoints.manga.template': '${baseUrl}/manga',
      'api.endpoints.cover.template': '${baseUrl}/cover',
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

/**
 * @param {CoverSearchResult} cover
 */
function assertCoverSearchContract(cover) {
  assert.equal(typeof cover.source, 'string');
  assert.equal(cover.source.length > 0, true);
  assert.equal(typeof cover.title, 'string');
  assert.equal(cover.title.length > 0, true);
  assert.equal(typeof cover.thumbnailUrl, 'string');
  assert.equal(cover.thumbnailUrl.length > 0, true);
  assert.equal(typeof cover.canonicalUrl, 'string');
  assert.equal(cover.canonicalUrl.length > 0, true);

  assert.equal(typeof cover.tracker?.id, 'string');
  assert.equal(cover.tracker.id.length > 0, true);
  assert.equal(typeof cover.tracker?.url, 'string');
  assert.equal(cover.tracker.url.length > 0, true);

  // host-capability-contract.md §2's enrich.cover mapping -- additive field, matches
  // downloadCover(coverId)'s own "${mangaId}/${fileName}" bridging convention
  // (Plan-2026Q3-mangadex-capability-vocabulary, Phase 4).
  assert.equal(typeof cover.coverId, 'string');
  assert.equal(cover.coverId, `${cover.tracker.id}/${cover.tracker.fileName}`);

  assert.equal(typeof cover.fetchedAt, 'string');
  assert.equal(cover.fetchedAt.length > 0, true);
  assert.equal(Number.isFinite(cover.telemetry?.durationMs), true);
  assert.equal(typeof cover.telemetry?.cacheHit, 'boolean');
  assert.equal(Number.isInteger(cover.telemetry?.attempts), true);
  assert.equal((cover.telemetry?.attempts || 0) >= 1, true);
}

test('search flow - search prioritizes exact match over fuzzy match', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'search-access', refresh_token: 'search-refresh' },
  });

  httpHooks.getHandler = (url) => {
    const value = String(url);

    if (value.endsWith('/manga')) {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'exact-1',
              type: 'manga',
              attributes: {
                title: { en: 'Solo Leveling' },
                altTitles: [{ ko: 'Na Honjaman Level Up' }],
                description: { en: 'Exact match' },
              },
              relationships: [{ type: 'author', id: 'author-1' }],
            },
            {
              id: 'fuzzy-2',
              type: 'manga',
              attributes: {
                title: { en: 'Solo Leveling Ragnarok' },
                altTitles: [],
                description: { en: 'Fuzzy match' },
              },
              relationships: [{ type: 'author', id: 'author-1' }],
            },
          ],
          included: [],
        },
      };
    }

    if (value.endsWith('/author')) {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'author-1',
              attributes: { name: 'Chugong' },
            },
          ],
        },
      };
    }

    if (value.endsWith('/cover')) {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'cover-1',
              attributes: {
                fileName: 'cover-a.jpg',
                volume: '1',
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const matches = await wrapper.search('Solo Leveling', { useCache: false });

  assert.equal(matches.length >= 1, true);
  assert.equal(matches[0].trackerId, 'exact-1');
  assert.equal(matches[0].matchType, 'exact');
});

test('search flow - searchTrackersRaw prioritizes exact matches over fuzzy matches', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'search-access', refresh_token: 'search-refresh' },
  });

  httpHooks.getHandler = (url) => {
    if (String(url).endsWith('/manga')) {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'fuzzy-first',
              attributes: {
                title: { en: 'Solo Leveling Ragnarok' },
                altTitles: [],
              },
            },
            {
              id: 'exact-second',
              attributes: {
                title: { en: 'Solo Leveling' },
                altTitles: [{ ko: 'Na Honjaman Level Up' }],
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const raw = await wrapper.searchTrackersRaw({ title: 'Solo Leveling' }, { useCache: false });

  assert.equal(raw.payload.data.length, 1);
  assert.equal(raw.payload.data[0]?.id, 'exact-second');
  assert.equal(raw.payload.data[0]?.title, 'Solo Leveling');
  assert.equal(typeof raw.payload.data[0]?.attributes, 'object');
});

test('search flow - searchTrackersRaw evaluates alias query after weak primary title results and returns exact alias snapshot', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'search-access', refresh_token: 'search-refresh' },
  });

  httpHooks.getHandler = (url, config) => {
    const value = String(url);
    const query = config && typeof config === 'object' && config.params && typeof config.params === 'object'
      ? String(config.params.title || '')
      : '';

    if (value.endsWith('/manga') && query === 'Bad Primary Title') {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'weak-primary',
              attributes: {
                title: { en: 'Bad Primary Title Side Story' },
                altTitles: [],
              },
            },
          ],
        },
      };
    }

    if (value.endsWith('/manga') && query === 'Alias Exact Title') {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'alias-exact',
              attributes: {
                title: { en: 'Alias Exact Title' },
                altTitles: [{ ja: 'Alias Exact' }],
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const raw = await wrapper.searchTrackersRaw(
    {
      title: 'Bad Primary Title',
      aliases: ['Alias Exact Title'],
    },
    { useCache: false },
  );

  const searchCalls = httpHooks.getCalls
    .filter((call) => String(call.url).endsWith('/manga'))
    .map((call) => call.config && call.config.params ? String(call.config.params.title || '') : '');

  assert.deepEqual(searchCalls, ['Bad Primary Title', 'Alias Exact Title']);
  assert.equal(raw.payload.data.length, 1);
  assert.equal(raw.payload.data[0]?.id, 'alias-exact');
  assert.equal(raw.payload.data[0]?.title, 'Alias Exact Title');
});

test('search flow - search prefers highest-score title snapshot when no exact match exists', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'search-access', refresh_token: 'search-refresh' },
  });

  httpHooks.getHandler = (url, config) => {
    const value = String(url);
    const query = config && typeof config === 'object' && config.params && typeof config.params === 'object'
      ? String(config.params.title || '')
      : '';

    if (value.endsWith('/manga') && query === 'Weak Primary') {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'weak-fuzzy',
              type: 'manga',
              attributes: {
                title: { en: 'Weak Hero Primary' },
                altTitles: [],
                description: { en: 'Weak fuzzy candidate' },
              },
              relationships: [],
            },
          ],
        },
      };
    }

    if (value.endsWith('/manga') && query === 'Better Alias') {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'better-fuzzy',
              type: 'manga',
              attributes: {
                title: { en: 'Better Alias Chronicles' },
                altTitles: [{ ja: 'Better Alias Tale' }],
                description: { en: 'Higher fuzzy candidate' },
              },
              relationships: [],
            },
          ],
        },
      };
    }

    if (value.endsWith('/cover')) {
      return { status: 200, data: { data: [] } };
    }

    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const matches = await wrapper.search('Weak Primary', { useCache: false });

  const searchCalls = httpHooks.getCalls
    .filter((call) => String(call.url).endsWith('/manga'))
    .map((call) => call.config && call.config.params ? String(call.config.params.title || '') : '');

  assert.deepEqual(searchCalls, ['Weak Primary']);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.trackerId, 'weak-fuzzy');
  assert.equal(matches[0]?.matchType, 'fuzzy');
});

test('cover flow - searchCovers falls back to fuzzy match and normalizes dimensions', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'cover-access', refresh_token: 'cover-refresh' },
  });

  httpHooks.getHandler = (url) => {
    const value = String(url);

    if (value.endsWith('/manga')) {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'fuzzy-cover-id',
              attributes: {
                title: { en: 'Solo Leveling Ragnarok' },
                altTitles: [],
              },
            },
          ],
        },
      };
    }

    if (value.endsWith('/cover')) {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'cover-fuzzy-1',
              attributes: {
                fileName: 'fuzzy-cover.jpg',
                volume: '2',
                width: 1200,
                height: 1800,
                description: 'Fuzzy fallback cover',
              },
              relationships: [{ type: 'manga', id: 'fuzzy-cover-id' }],
            },
          ],
        },
      };
    }

    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const covers = await wrapper.searchCovers({ title: 'Solo Leveling' }, { useCache: false });

  assert.equal(covers.length, 1);
  assertCoverSearchContract(covers[0]);
  assert.equal(covers[0].tracker.id, 'fuzzy-cover-id');
  assert.deepEqual(covers[0].dimensions, { width: 1200, height: 1800 });
  assert.equal(covers[0].tracker.fileName, 'fuzzy-cover.jpg');
  assert.equal(covers[0].tracker.score, 85);
});

test('cover flow - searchCovers emits progress events and sorts covers by volume', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'cover-access', refresh_token: 'cover-refresh' },
  });

  httpHooks.getHandler = (url) => {
    if (String(url).endsWith('/cover')) {
      return {
        status: 200,
        data: {
          data: [
            {
              id: 'cover-v3',
              attributes: { fileName: 'vol-3.jpg', volume: '3' },
            },
            {
              id: 'cover-v1',
              attributes: { fileName: 'vol-1.jpg', volume: '1' },
            },
          ],
        },
      };
    }

    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const progressEvents = [];
  const covers = await wrapper.searchCovers(
    { title: 'Direct Tracker Cover' },
    {
      trackerId: 'direct-cover-id',
      useCache: false,
      onProgress(event) {
        progressEvents.push(event.status);
      },
    },
  );

  assert.equal(Array.isArray(progressEvents), true);
  assert.equal(progressEvents[0], 'running');
  assert.equal(progressEvents[progressEvents.length - 1], 'complete');
  assert.equal(covers.length, 2);
  assertCoverSearchContract(covers[0]);
  assertCoverSearchContract(covers[1]);
  assert.equal(covers[0].tracker.volume, '1');
  assert.equal(covers[1].tracker.volume, '3');
  assert.equal(covers[0].tracker.score, 100);
  assert.equal(covers[1].tracker.score, 100);
});

// host-capability-contract.md §2's enrich.cover mapping -- downloadCover(coverId): Promise<Buffer>.
// Plan-2026Q3-mangadex-capability-vocabulary, Phase 4: refactored from the pre-migration
// (metadata, savePath): Promise<boolean> shape -- the plugin no longer writes to disk itself
// (ImageService.downloadCover() does that now), and coverId is the "${mangaId}/${fileName}"
// bridging convention ImageService's own _invokeProviderDownload() constructs.

test('cover flow - downloadCover(coverId) returns image bytes, never writes to disk itself', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (String(url).includes('uploads.mangadex.org/covers')) {
      return {
        status: 200,
        data: Buffer.from('cover-bytes'),
      };
    }

    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);

  const buffer = await wrapper.downloadCover('series-cover/cover-a.jpg');

  assert.equal(Buffer.isBuffer(buffer), true);
  assert.equal(buffer.length > 0, true);
  assert.equal(buffer.toString(), 'cover-bytes');
  assert.equal(httpHooks.getCalls.some((c) => String(c.url).includes('uploads.mangadex.org/covers/series-cover/cover-a.jpg')), true);
});

test('cover flow - downloadCover(coverId) reuses the cache, no second HTTP GET', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (String(url).includes('uploads.mangadex.org/covers')) {
      return { status: 200, data: Buffer.from('cover-bytes') };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);

  const first = await wrapper.downloadCover('series-cover/cover-a.jpg');
  const coverGetCallsAfterFirst = httpHooks.getCalls.filter((c) => String(c.url).includes('uploads.mangadex.org/covers')).length;
  const second = await wrapper.downloadCover('series-cover/cover-a.jpg');
  const coverGetCallsAfterSecond = httpHooks.getCalls.filter((c) => String(c.url).includes('uploads.mangadex.org/covers')).length;

  assert.equal(first.toString(), 'cover-bytes');
  assert.equal(second.toString(), 'cover-bytes');
  assert.equal(coverGetCallsAfterFirst, 1);
  assert.equal(coverGetCallsAfterSecond, 1, 'the second call must be served from cache, not a new HTTP GET');
});

test('cover flow - downloadCover() throws on a malformed coverId, not just returns false', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, context);

  await assert.rejects(() => wrapper.downloadCover('not-a-valid-coverid'));
  await assert.rejects(() => wrapper.downloadCover(''));
});

test('cover flow - downloadCover() throws on an empty response body', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = () => ({ status: 200, data: Buffer.alloc(0) });

  const wrapper = await createWrapper(client, context);

  await assert.rejects(() => wrapper.downloadCover('series-cover/missing.jpg'));
});
