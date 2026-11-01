'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
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

// Token cache keys carry the identity of the credential the token was issued for.
function identityOf(clientId, username) {
  return crypto.createHash('sha256').update(`${clientId}:${username}`).digest('hex').slice(0, 12);
}
const DEMO_ACCESS_KEY = `mangadex_access_token:${identityOf('client-id', 'demo')}`;
const DEMO_REFRESH_KEY = `mangadex_refresh_token:${identityOf('client-id', 'demo')}`;

function tokenResponder(hooks, prefix = 'token') {
  let issued = 0;
  hooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      issued += 1;
      return { status: 200, data: { access_token: `${prefix}-access-${issued}`, refresh_token: `${prefix}-refresh-${issued}` } };
    }
    return { status: 200, data: {} };
  };
}

function httpError(status) {
  const error = new Error(`Request failed with status code ${status}`);
  // @ts-ignore axios-shaped error
  error.response = { status };
  return error;
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
    client_id: 'client-id',
    client_secret: 'client-secret',
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
  assert.equal(cacheHooks.data.get(DEMO_ACCESS_KEY), 'token-access');
  assert.equal(cacheHooks.data.get(DEMO_REFRESH_KEY), 'token-refresh');

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
  const { context, hooks: cacheHooks } = createMockContext({ [DEMO_REFRESH_KEY]: 'stale-refresh-token' });
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
  assert.equal(cacheHooks.deletedKeys.includes(DEMO_REFRESH_KEY), true);
  assert.equal(cacheHooks.data.get(DEMO_REFRESH_KEY), 'fallback-refresh');

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: the stale-refresh-token delete is user-scoped too.
  const deleteCall = cacheHooks.deletes.find((d) => d.key === DEMO_REFRESH_KEY);
  assert.deepEqual(deleteCall?.options, { userScoped: true });
});

test('token flow - an expired in-memory token is never reused', async () => {
  const { context, hooks: cacheHooks } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();
  tokenResponder(httpHooks);

  const wrapper = await createWrapper(client, context);
  assert.equal(await wrapper.getToken(), 'token-access-1');

  // Past its lifetime, and gone from the cache (its TTL lapsed there too).
  wrapper._bearer.expiresAt = Date.now() - 1;
  cacheHooks.data.delete(DEMO_ACCESS_KEY);

  assert.equal(await wrapper.getToken(), 'token-access-2');
});

test('token flow - a token read back from the cache is held only briefly', async () => {
  const { context } = createMockContext({ [DEMO_ACCESS_KEY]: 'cached-access' });
  const { client, hooks: httpHooks } = createMockHttpClient();
  tokenResponder(httpHooks);

  const wrapper = await createWrapper(client, context);
  const before = Date.now();
  assert.equal(await wrapper.getToken(), 'cached-access');
  assert.equal(httpHooks.postCalls.length, 0);
  assert.ok(wrapper._bearer.expiresAt <= before + 60 * 1000 + 50, 'cached token is held at most 60 s');
});

test('token flow - a different credential never gets the previous credential\'s token', async () => {
  const { context, hooks: cacheHooks } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();
  tokenResponder(httpHooks);

  const wrapper = await createWrapper(client, context);
  assert.equal(await wrapper.getToken(), 'token-access-1');

  // The host re-applies another credential (e.g. the system slot) before its own operation.
  await wrapper.setCredentials({ username: 'system', password: 'pw', client_id: 'client-id', client_secret: 's' });
  assert.equal(wrapper._bearer, null, 'switching credential drops the in-memory token');
  assert.equal(await wrapper.getToken(), 'token-access-2');
  assert.equal(cacheHooks.data.get(`mangadex_access_token:${identityOf('client-id', 'system')}`), 'token-access-2');

  // Back to the first credential: its own token comes back from its own cache key, no new login.
  await wrapper.setCredentials({ username: 'demo', password: 'secret', client_id: 'client-id', client_secret: 'client-secret' });
  assert.equal(await wrapper.getToken(), 'token-access-1');
  assert.equal(httpHooks.postCalls.length, 2);
});

test('token flow - a 401 drops the token, signs in again and retries once', async () => {
  const { context, hooks: cacheHooks } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();
  tokenResponder(httpHooks);

  const wrapper = await createWrapper(client, context);
  const seen = [];
  const result = await wrapper._authed(async (token) => {
    seen.push(token);
    if (seen.length === 1) throw httpError(401);
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.deepEqual(seen, ['token-access-1', 'token-access-2']);
  assert.ok(cacheHooks.deletes.some((d) => d.key === DEMO_ACCESS_KEY && d.options?.userScoped === true));
});

test('token flow - a second 401 fails without looping; other errors never retry', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();
  tokenResponder(httpHooks);

  const wrapper = await createWrapper(client, context);
  let calls = 0;
  await assert.rejects(wrapper._authed(async () => { calls += 1; throw httpError(401); }), /401/);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(wrapper._authed(async () => { calls += 1; throw httpError(500); }), /500/);
  assert.equal(calls, 1);
});

test('token flow - subscribe() reports a refused sign-in in words the host can show', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();
  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'a', refresh_token: 'r' } };
    }
    throw httpError(401);
  };

  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
      'api.endpoints.refreshToken.template': '${authUrl}/token',
      'api.endpoints.follow.template': '${baseUrl}/manga/${id}/follow',
    },
    httpClient: client,
    context,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret', client_id: 'client-id', client_secret: 'client-secret' });

  const [result] = await wrapper.subscribe([{ pluginEntryId: 'series-x' }]);
  assert.equal(result.success, false);
  assert.match(result.error, /HTTP 401/);
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
    client_id: 'client-id',
    client_secret: 'client-secret',
  });

  await assert.rejects(
    async () => wrapper._fetchNewToken(await wrapper.getCredentials(), { forceRefresh: true }),
    /Missing token endpoint configuration/,
  );
});
