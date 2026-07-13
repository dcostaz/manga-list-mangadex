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

/**
 * Plan-2026Q3-namespacedcacheadapter-user-isolation: captures the full options
 * argument on every call, not just key/value, so tests can assert
 * { userScoped: true } is actually passed at each migrated call site.
 */
function createMockContext(initialData) {
  const hooks = {
    data: new Map(Object.entries(initialData || {})),
    reads: [],
    writes: [],
    deletedKeys: [],
    deletes: [],
  };

  return {
    context: {
      utils: {
        sanitizeForSearch: (text) => (typeof text === 'string' ? text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : ''),
      },
      cache: {
        async getValue(key, options) {
          hooks.reads.push({ key, options });
          return hooks.data.has(key) ? hooks.data.get(key) || null : null;
        },
        async setValue(key, value, ttlSeconds, options) {
          hooks.data.set(key, value);
          hooks.writes.push({ key, value, ttlSeconds, options });
        },
        async deleteValue(key, options) {
          hooks.deletedKeys.push(key);
          hooks.deletes.push({ key, options });
          hooks.data.delete(key);
        },
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

async function createWrapper(httpClient, context) {
  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
      'api.endpoints.refreshToken.template': '${authUrl}/token',
    },
    httpClient,
    context,
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
  const { context, hooks: cacheHooks } = createMockContext();
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

  const wrapper = await createWrapper(client, context);
  const token = await wrapper.getToken();
  const tokenAgain = await wrapper.getToken();

  assert.equal(token, 'token-access');
  assert.equal(tokenAgain, 'token-access');
  assert.equal(httpHooks.postCalls.length, 1);
  assert.equal(cacheHooks.data.get('mangadex_access_token'), 'token-access');
  assert.equal(cacheHooks.data.get('mangadex_refresh_token'), 'token-refresh');

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: both tokens are user-derived.
  assert.ok(cacheHooks.writes.every((w) => w.options?.userScoped === true), 'every token write must pass userScoped: true');
  assert.ok(cacheHooks.reads.every((r) => r.options?.userScoped === true), 'every token read must pass userScoped: true');
});

test('token flow - getToken throws when credentials are missing', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();

  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
      'api.endpoints.refreshToken.template': '${authUrl}/token',
    },
    httpClient: client,
    context,
  });

  // No credentials set — should throw
  await assert.rejects(
    async () => wrapper.getToken(),
    /Credentials not found/,
  );
});

test('token flow - token cache key and ttl follow mangadex conventions', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, context);

  assert.equal(wrapper._getTokenCacheKey('access_token'), 'mangadex_access_token');
  assert.equal(wrapper._getTokenCacheKey('refresh_token'), 'mangadex_refresh_token');
  assert.equal(wrapper._getTokenTTL('access_token'), 900);
  assert.equal(wrapper._getTokenTTL('refresh_token'), 2592000);
  assert.equal(wrapper._getTokenTTL('anything-else'), 60);
});

test('token flow - refresh token failure falls back to password flow and clears refresh cache', async () => {
  const { context, hooks: cacheHooks } = createMockContext({ mangadex_refresh_token: 'stale-refresh-token' });
  const { client, hooks: httpHooks } = createMockHttpClient();

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

  const wrapper = await createWrapper(client, context);
  const token = await wrapper.getToken();

  assert.equal(token, 'fallback-access');
  assert.equal(httpHooks.postCalls.length, 2);
  assert.equal(cacheHooks.deletedKeys.includes('mangadex_refresh_token'), true);
  assert.equal(cacheHooks.data.get('mangadex_refresh_token'), 'fallback-refresh');

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: the stale-refresh-token delete is user-scoped too.
  const deleteCall = cacheHooks.deletes.find((d) => d.key === 'mangadex_refresh_token');
  assert.deepEqual(deleteCall?.options, { userScoped: true });
});

test('token flow - missing token endpoint config fails fast', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();

  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
    },
    httpClient: client,
    context,
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
