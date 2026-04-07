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
    postCalls: [],
    deleteCalls: [],
    postHandler: () => ({ status: 200, data: {} }),
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
    async post(url, payload, config) {
      hooks.postCalls.push({ url, payload, config });
      const out = hooks.postHandler(url, payload, config);
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

test('write flow - subscribeToReadingList follows and maps status', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'write-access', refresh_token: 'write-refresh' },
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

test('write flow - setUserProgress returns success false when status missing', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'write-access', refresh_token: 'write-refresh' },
  });

  const wrapper = await createWrapper(client, cacheAdapter);
  const result = await wrapper.setUserProgress('series-1', { chapter: 10 });

  assert.equal(result.success, false);
  assert.equal(typeof result.error, 'string');
});

test('write flow - updateStatus returns response status and updates cache', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'write-access', refresh_token: 'write-refresh' },
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

test('write flow - unfollowManga deletes cached status key', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'write-access', refresh_token: 'write-refresh' },
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

test('write flow - setUserProgress with status delegates to status update and succeeds', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'write-access', refresh_token: 'write-refresh' },
      };
    }

    return {
      status: 200,
      data: { ok: true },
    };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const result = await wrapper.setUserProgress('series-progress', { status: 'READING', chapter: 101 });

  assert.equal(result.success, true);
  assert.equal(typeof result.message, 'string');
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/manga/series-progress/status')), true);
});
