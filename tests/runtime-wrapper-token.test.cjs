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
    writes: [],
    deletedKeys: [],
  };

  return {
    cacheAdapter: {
      async getValue(key) {
        return hooks.data.has(key) ? hooks.data.get(key) || null : null;
      },
      async setValue(key, value, ttlSeconds) {
        hooks.data.set(key, value);
        hooks.writes.push({ key, value, ttlSeconds });
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

async function createWrapper(httpClient, cacheAdapter, onCredentialsRequired) {
  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
      'api.endpoints.refreshToken.template': '${authUrl}/token',
    },
    httpClient,
    cacheAdapter,
    onCredentialsRequired,
  });

  await wrapper.setCredentials({
    username: 'demo',
    password: 'secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });

  return wrapper;
}

test('token flow - getToken fetches and caches access token', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: {
          access_token: 'token-access',
          refresh_token: 'token-refresh',
        },
      };
    }

    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const token = await wrapper.getToken();
  const tokenAgain = await wrapper.getToken();

  assert.equal(token, 'token-access');
  assert.equal(tokenAgain, 'token-access');
  assert.equal(httpHooks.postCalls.length, 1);
  assert.equal(cacheHooks.data.get('mangadex_access_token'), 'token-access');
  assert.equal(cacheHooks.data.get('mangadex_refresh_token'), 'token-refresh');
});

test('token flow - callback can provide credentials when missing', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: {
      access_token: 'callback-access',
      refresh_token: 'callback-refresh',
    },
  });

  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
      'api.endpoints.refreshToken.template': '${authUrl}/token',
    },
    httpClient: client,
    cacheAdapter,
    onCredentialsRequired: async () => ({
      username: 'demo',
      password: 'secret',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }),
  });

  const token = await wrapper.getToken();
  assert.equal(token, 'callback-access');
  assert.equal(httpHooks.postCalls.length, 1);
});

test('token flow - token cache key and ttl follow mangadex conventions', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, cacheAdapter);

  assert.equal(wrapper._getTokenCacheKey('access_token'), 'mangadex_access_token');
  assert.equal(wrapper._getTokenCacheKey('refresh_token'), 'mangadex_refresh_token');
  assert.equal(wrapper._getTokenTTL('access_token'), 900);
  assert.equal(wrapper._getTokenTTL('refresh_token'), 2592000);
  assert.equal(wrapper._getTokenTTL('anything-else'), 60);
});

test('token flow - refresh token failure falls back to password flow and clears refresh cache', async () => {
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
        access_token: 'fallback-access',
        refresh_token: 'fallback-refresh',
      },
    };
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const token = await wrapper.getToken();

  assert.equal(token, 'fallback-access');
  assert.equal(httpHooks.postCalls.length, 2);
  assert.equal(cacheHooks.deletedKeys.includes('mangadex_refresh_token'), true);
  assert.equal(cacheHooks.data.get('mangadex_refresh_token'), 'fallback-refresh');
});

test('token flow - missing token endpoint config fails fast', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
    },
    httpClient: client,
    cacheAdapter,
  });

  await wrapper.setCredentials({
    username: 'demo',
    password: 'secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });

  await assert.rejects(
    async () => wrapper._fetchNewToken(await wrapper.getCredentials(), { forceRefresh: true }),
    /Missing token endpoint configuration/,
  );
});
