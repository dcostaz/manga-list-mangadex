'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

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

test('read flow - searchTrackersRaw maps MangaDex rows to mapper payload shape', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'read-access', refresh_token: 'read-refresh' },
  });

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

test('read flow - getSeriesByIdRaw returns compact id and title payload', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'read-access', refresh_token: 'read-refresh' },
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

test('read flow - getReadingStatus returns null for 404 responses', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'read-access', refresh_token: 'read-refresh' },
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

test('read flow - getReadingStatus uses cache when available', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  cacheHooks.data.set('mangadex_readingStatus_series-cached', 'reading');

  const wrapper = await createWrapper(client, cacheAdapter);
  const status = await wrapper.getReadingStatus('series-cached', true);

  assert.equal(status, 'reading');
  assert.equal(httpHooks.getCalls.length, 0);
});

test('read flow - getUserProgressRaw returns normalized payload', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'read-access', refresh_token: 'read-refresh' },
  });
  httpHooks.getHandler = () => ({
    status: 200,
    data: { status: 'completed' },
  });

  const wrapper = await createWrapper(client, cacheAdapter);
  const raw = await wrapper.getUserProgressRaw('series-42');

  assert.equal(raw.operation, 'getUserProgressRaw');
  assert.equal(raw.payload.trackerId, 'series-42');
  assert.equal(raw.payload.status, 'completed');
  assert.equal(raw.payload.chapter, null);
  assert.equal(raw.payload.volume, null);
  assert.equal(raw.payload.rating, null);
});
