'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;

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

function createMockCacheAdapter() {
  const hooks = {
    data: new Map(),
  };

  return {
    cacheAdapter: {
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

async function createWrapper(httpClient, cacheAdapter) {
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
    cacheAdapter,
  });

  await wrapper.setCredentials({
    username: 'demo',
    password: 'secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });

  return wrapper;
}

test('search flow - searchTrackers prioritizes exact match over fuzzy match', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
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

  const wrapper = await createWrapper(client, cacheAdapter);
  const matches = await wrapper.searchTrackers({ title: 'Solo Leveling' }, { useCache: false });

  assert.equal(matches.length >= 1, true);
  assert.equal(matches[0].trackerId, 'exact-1');
  assert.equal(matches[0].matchType, 'exact');
});

test('search flow - searchTrackersRaw prioritizes exact matches over fuzzy matches', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
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

  const wrapper = await createWrapper(client, cacheAdapter);
  const raw = await wrapper.searchTrackersRaw({ title: 'Solo Leveling' }, { useCache: false });

  assert.equal(raw.payload.data.length, 1);
  assert.equal(raw.payload.data[0]?.id, 'exact-second');
  assert.equal(raw.payload.data[0]?.title, 'Solo Leveling');
  assert.equal(typeof raw.payload.data[0]?.attributes, 'object');
});

test('cover flow - searchCovers falls back to fuzzy match and normalizes dimensions', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
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

  const wrapper = await createWrapper(client, cacheAdapter);
  const covers = await wrapper.searchCovers({ title: 'Solo Leveling' }, { useCache: false });

  assert.equal(covers.length, 1);
  assert.equal(covers[0].tracker.id, 'fuzzy-cover-id');
  assert.deepEqual(covers[0].dimensions, { width: 1200, height: 1800 });
  assert.equal(covers[0].tracker.fileName, 'fuzzy-cover.jpg');
});

test('cover flow - searchCovers emits progress events and sorts covers by volume', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
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

  const wrapper = await createWrapper(client, cacheAdapter);
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
  assert.equal(covers[0].tracker.volume, '1');
  assert.equal(covers[1].tracker.volume, '3');
});

test('cover flow - downloadCover writes file and reuses cache', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
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

  const wrapper = await createWrapper(client, cacheAdapter);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangadex-cover-wave5-'));
  const outputFile = path.join(tempDir, 'cover.bin');

  try {
    const downloaded = await wrapper.downloadCover(
      { mangaId: 'series-cover', fileName: 'cover-a.jpg' },
      outputFile,
    );

    assert.equal(downloaded, true);
    const written = await fs.readFile(outputFile);
    assert.equal(written.length > 0, true);

    const secondFile = path.join(tempDir, 'cover-cache.bin');
    const downloadedAgain = await wrapper.downloadCover(
      { mangaId: 'series-cover', fileName: 'cover-a.jpg' },
      secondFile,
    );

    assert.equal(downloadedAgain, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
