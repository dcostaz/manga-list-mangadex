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
        async getValue(key) {
          return hooks.data.has(key) ? hooks.data.get(key) || null : null;
        },
        async setValue(key, value, ttlSeconds, options) {
          hooks.data.set(key, value);
          hooks.writes.push({ key, value, options });
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

async function createWrapper(httpClient, context) {
  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
      'api.endpoints.refreshToken.template': '${authUrl}/token',
      'api.endpoints.follow.template': '${baseUrl}/manga/${id}/follow',
      'api.endpoints.status.template': '${baseUrl}/manga/${id}/status',
      'api.endpoints.rating.template': '${baseUrl}/rating/${id}',
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

test('write flow - subscribe follows and maps status', async () => {
  const { context, hooks: cacheHooks } = createMockContext();
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

  const wrapper = await createWrapper(client, context);
  await wrapper.subscribe('series-follow', { readingStatus: 'COMPLETED' });

  assert.equal(httpHooks.postCalls.length, 3);
  assert.equal(httpHooks.postCalls[1].url, 'https://api.mangadex.org/manga/series-follow/follow');
  assert.equal(httpHooks.postCalls[2].url, 'https://api.mangadex.org/manga/series-follow/status');
  assert.deepEqual(httpHooks.postCalls[2].payload, { status: 'completed' });
  assert.equal(cacheHooks.data.get('mangadex_readingStatus_series-follow'), 'completed');

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: found during Phase 4 execution -- subscribe()'s
  // reading-status write was missing from the original call-site inventory.
  const statusWrite = cacheHooks.writes.find((w) => w.key === 'mangadex_readingStatus_series-follow');
  assert.deepEqual(statusWrite?.options, { userScoped: true });
});

test('write flow - pushProgress returns success false when status missing', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'write-access', refresh_token: 'write-refresh' },
  });

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.pushProgress('series-1', { chapter: 10 });

  assert.equal(result.success, false);
  assert.equal(typeof result.error, 'string');
});

test('write flow - updateStatus returns response status and updates cache', async () => {
  const { context, hooks: cacheHooks } = createMockContext();
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

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.updateStatus('series-status', 'completed');

  assert.equal(result.status, 202);
  assert.deepEqual(result.data, { result: 'ok' });
  assert.equal(cacheHooks.data.get('mangadex_readingStatus_series-status'), 'completed');

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: reading status is per-user state.
  const statusWrite = cacheHooks.writes.find((w) => w.key === 'mangadex_readingStatus_series-status');
  assert.deepEqual(statusWrite?.options, { userScoped: true });
});

test('write flow - unfollowManga deletes cached status key', async () => {
  const { context, hooks: cacheHooks } = createMockContext({ 'mangadex_readingStatus_series-unfollow': 'reading' });
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

  const wrapper = await createWrapper(client, context);
  await wrapper.unfollowManga('series-unfollow');

  assert.equal(httpHooks.deleteCalls.length, 1);
  assert.equal(httpHooks.deleteCalls[0].url, 'https://api.mangadex.org/manga/series-unfollow/follow');
  assert.equal(cacheHooks.deletedKeys.includes('mangadex_readingStatus_series-unfollow'), true);
  assert.equal(cacheHooks.data.has('mangadex_readingStatus_series-unfollow'), false);

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: reading status is per-user state.
  const statusDelete = cacheHooks.deletes.find((d) => d.key === 'mangadex_readingStatus_series-unfollow');
  assert.deepEqual(statusDelete?.options, { userScoped: true });
});

test('write flow - pushProgress with status delegates to status update and succeeds', async () => {
  const { context } = createMockContext();
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

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.pushProgress('series-progress', { status: 'READING', chapter: 101 });

  assert.equal(result.success, true);
  assert.equal(typeof result.message, 'string');
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/manga/series-progress/status')), true);
});

test('write flow - updateRating posts to the real rating endpoint (2026-07-23 fix: was a hard "not supported" stub)', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: { result: 'ok' } };
  };

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.updateRating('series-rating', 8);

  assert.equal(result.status, 200);
  const ratingCall = httpHooks.postCalls.find((call) => String(call.url).endsWith('/rating/series-rating'));
  assert.ok(ratingCall, 'expected a POST to /rating/series-rating');
  assert.equal(ratingCall.payload.rating, 8);
});

test('write flow - updateRating rejects out-of-range values without calling the API', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  const wrapper = await createWrapper(client, context);
  await assert.rejects(() => wrapper.updateRating('series-rating', 11));
  await assert.rejects(() => wrapper.updateRating('series-rating', 0));
  assert.equal(httpHooks.postCalls.filter((c) => String(c.url).includes('/rating/')).length, 0);
});

test('write flow - deleteRating issues a real DELETE to the rating endpoint', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: {} };
  };
  httpHooks.deleteHandler = () => ({ status: 200, data: { result: 'ok' } });

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.deleteRating('series-rating');

  assert.equal(result.status, 200);
  assert.ok(httpHooks.deleteCalls.some((c) => String(c.url).endsWith('/rating/series-rating')));
});

test('write flow - pushProgress routes rating:0 to deleteRating, not updateRating (mangalist\'s own 0-means-cleared scale vs MangaDex\'s zero-less 1-10 range)', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: {} };
  };
  httpHooks.deleteHandler = () => ({ status: 200, data: { result: 'ok' } });

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.pushProgress('series-progress', { rating: 0 });

  assert.equal(result.success, true);
  assert.deepEqual(result.updatedFields, ['rating']);
  assert.ok(httpHooks.deleteCalls.some((c) => String(c.url).endsWith('/rating/series-progress')), 'expected a DELETE, not a POST, for rating:0');
  assert.equal(httpHooks.postCalls.some((c) => String(c.url).endsWith('/rating/series-progress')), false);
});

test('write flow - pushProgress with only rating succeeds without touching status', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: { result: 'ok' } };
  };

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.pushProgress('series-progress', { rating: 9 });

  assert.equal(result.success, true);
  assert.deepEqual(result.updatedFields, ['rating']);
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/manga/series-progress/status')), false);
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/rating/series-progress')), true);
});

test('write flow - pushProgress with both status and rating updates both independently', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: { result: 'ok' } };
  };

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.pushProgress('series-progress', { status: 'COMPLETED', rating: 10 });

  assert.equal(result.success, true);
  assert.deepEqual(result.updatedFields, ['status', 'rating']);
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/manga/series-progress/status')), true);
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/rating/series-progress')), true);
});

test('write flow - pushProgress with neither status nor rating fails cleanly', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.pushProgress('series-progress', { chapter: 5 });

  assert.equal(result.success, false);
  assert.equal(typeof result.error, 'string');
});
