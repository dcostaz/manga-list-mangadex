'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;

const MangaDexAPIWrapper = require(path.join(
  __dirname,
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
    deletedKeys: [],
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
        hooks.deletedKeys.push(key);
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
    putCalls: [],
    patchCalls: [],
    deleteCalls: [],
    getHandler: () => ({ status: 200, data: {} }),
    postHandler: () => ({ status: 200, data: {} }),
    putHandler: () => ({ status: 200, data: {} }),
    patchHandler: () => ({ status: 200, data: {} }),
    deleteHandler: () => ({ status: 200, data: {} }),
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
    async put(url, payload, config) {
      hooks.putCalls.push({ url, payload, config });
      const out = hooks.putHandler(url, payload, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
    },
    async patch(url, payload, config) {
      hooks.patchCalls.push({ url, payload, config });
      const out = hooks.patchHandler(url, payload, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
    },
    async delete(url, config) {
      hooks.deleteCalls.push({ url, config });
      const out = hooks.deleteHandler(url, config);
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
      'api.endpoints.follow.template': '${baseUrl}/manga/${id}/follow',
      'api.endpoints.status.template': '${baseUrl}/manga/${id}/status',
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

test('wave1 auth flow - getToken fetches and caches access token', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: {
          access_token: 'wave1-access',
          refresh_token: 'wave1-refresh',
        },
      };
    }

    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const token = await wrapper.getToken();
  const tokenAgain = await wrapper.getToken();

  assert.equal(token, 'wave1-access');
  assert.equal(tokenAgain, 'wave1-access');
  assert.equal(httpHooks.postCalls.length, 1);
  assert.equal(cacheHooks.data.get('mangadex_access_token'), 'wave1-access');
  assert.equal(cacheHooks.data.get('mangadex_refresh_token'), 'wave1-refresh');
});

test('wave1 read flow - searchTrackersRaw maps MangaDex rows to mapper payload shape', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'wave1-access', refresh_token: 'wave1-refresh' },
      };
    }
    return { status: 200, data: {} };
  };

  httpHooks.getHandler = () => ({
    status: 200,
    data: {
      data: [
        {
          id: 'mdx-1',
          attributes: {
            title: { en: 'Solo Leveling' },
            altTitles: [{ ko: 'Na Honjaman Level Up' }],
          },
        },
      ],
      included: [],
    },
  });

  const wrapper = await createWrapper(client, cacheAdapter);
  const raw = await wrapper.searchTrackersRaw({ title: 'Solo Leveling' }, { useCache: false });

  assert.equal(raw.trackerId, 'mangadex');
  assert.equal(raw.operation, 'searchTrackersRaw');
  assert.deepEqual(raw.payload.data, [
    { id: 'mdx-1', title: 'Solo Leveling' },
  ]);
});

test('wave1 read flow - getSeriesByIdRaw returns compact id/title payload', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'wave1-access', refresh_token: 'wave1-refresh' },
  });

  httpHooks.getHandler = (url) => {
    if (String(url).includes('/manga/series-123')) {
      return {
        status: 200,
        data: {
          data: {
            id: 'series-123',
            attributes: {
              title: { en: 'The Beginning After the End' },
            },
          },
          included: [],
        },
      };
    }

    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const raw = await wrapper.getSeriesByIdRaw('series-123', false);

  assert.equal(raw.payload.id, 'series-123');
  assert.equal(raw.payload.title, 'The Beginning After the End');
});

test('wave1 search flow - searchTrackers prioritizes exact match over fuzzy match', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'wave1-access', refresh_token: 'wave1-refresh' },
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

test('wave1 status flow - getReadingStatus returns null for 404 responses', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'wave1-access', refresh_token: 'wave1-refresh' },
  });

  httpHooks.getHandler = (url) => {
    if (String(url).includes('/status')) {
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }

    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const status = await wrapper.getReadingStatus('series-1', false);

  assert.equal(status, null);
});

test('wave1 write flow - subscribeToReadingList follows and maps status', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'wave1-access', refresh_token: 'wave1-refresh' },
      };
    }

    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  await wrapper.subscribeToReadingList({
    seriesId: 'series-follow',
    status: 'COMPLETED',
  });

  assert.equal(httpHooks.postCalls.length, 3);
  assert.equal(httpHooks.postCalls[1].url, 'https://api.mangadex.org/manga/series-follow/follow');
  assert.equal(httpHooks.postCalls[2].url, 'https://api.mangadex.org/manga/series-follow/status');
  assert.deepEqual(httpHooks.postCalls[2].payload, { status: 'completed' });
  assert.equal(cacheHooks.data.get('mangadex_readingStatus_series-follow'), 'completed');
});

test('wave1 write flow - setUserProgress returns success false when status missing', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'wave1-access', refresh_token: 'wave1-refresh' },
  });

  const wrapper = await createWrapper(client, cacheAdapter);
  const result = await wrapper.setUserProgress('series-1', { chapter: 10 });

  assert.equal(result.success, false);
  assert.equal(typeof result.error, 'string');
});

test('wave1 cover flow - downloadCover writes file and reuses cache', async () => {
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

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangadex-cover-wave1-'));
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

test('wave2 auth hardening - refresh token failure falls back to password flow and clears refresh cache', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  cacheHooks.data.set('mangadex_refresh_token', 'stale-refresh-token');

  httpHooks.postHandler = (_url, payload) => {
    const grantType = payload && typeof payload.get === 'function'
      ? payload.get('grant_type')
      : null;

    if (grantType === 'refresh_token') {
      throw new Error('refresh token expired');
    }

    return {
      status: 200,
      data: {
        access_token: 'wave2-access',
        refresh_token: 'wave2-refresh',
      },
    };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const token = await wrapper.getToken();

  assert.equal(token, 'wave2-access');
  assert.equal(httpHooks.postCalls.length, 2);
  assert.equal(cacheHooks.deletedKeys.includes('mangadex_refresh_token'), true);
  assert.equal(cacheHooks.data.get('mangadex_refresh_token'), 'wave2-refresh');
});

test('wave2 status hardening - getReadingStatus uses cache when available', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  cacheHooks.data.set('mangadex_readingStatus_series-cached', 'reading');

  const wrapper = await createWrapper(client, cacheAdapter);
  const status = await wrapper.getReadingStatus('series-cached', true);

  assert.equal(status, 'reading');
  assert.equal(httpHooks.getCalls.length, 0);
});

test('wave2 write hardening - updateStatus returns response status and updates cache', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'wave2-access', refresh_token: 'wave2-refresh' },
      };
    }

    return {
      status: 202,
      data: { result: 'ok' },
    };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const result = await wrapper.updateStatus('series-status', 'completed');

  assert.equal(result.status, 202);
  assert.deepEqual(result.data, { result: 'ok' });
  assert.equal(cacheHooks.data.get('mangadex_readingStatus_series-status'), 'completed');
});

test('wave2 write hardening - unfollowManga deletes cached status key', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'wave2-access', refresh_token: 'wave2-refresh' },
      };
    }

    return { status: 200, data: {} };
  };

  cacheHooks.data.set('mangadex_readingStatus_series-unfollow', 'reading');

  const wrapper = await createWrapper(client, cacheAdapter);
  await wrapper.unfollowManga('series-unfollow');

  assert.equal(httpHooks.deleteCalls.length, 1);
  assert.equal(httpHooks.deleteCalls[0].url, 'https://api.mangadex.org/manga/series-unfollow/follow');
  assert.equal(cacheHooks.deletedKeys.includes('mangadex_readingStatus_series-unfollow'), true);
  assert.equal(cacheHooks.data.has('mangadex_readingStatus_series-unfollow'), false);
});

test('wave3 search fidelity - searchTrackersRaw prioritizes exact matches over fuzzy matches', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'wave3-access', refresh_token: 'wave3-refresh' },
      };
    }

    return { status: 200, data: {} };
  };

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
  assert.deepEqual(raw.payload.data[0], {
    id: 'exact-second',
    title: 'Solo Leveling',
  });
});

test('wave3 cover fidelity - searchCovers falls back to fuzzy match and normalizes dimensions', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'wave3-access', refresh_token: 'wave3-refresh' },
      };
    }

    return { status: 200, data: {} };
  };

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

test('wave3 cover fidelity - searchCovers emits progress events and sorts covers by volume', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'wave3-access', refresh_token: 'wave3-refresh' },
      };
    }

    return { status: 200, data: {} };
  };

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
