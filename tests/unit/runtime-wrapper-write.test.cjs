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
    client_id: 'client-id',
    client_secret: 'client-secret',
  });

  return wrapper;
}

// host-capability-contract.md §2.1 -- subscribe.add's array-shaped subscribe(), called on every
// relevant Bookmark status edit under the new contract, not just the initial subscription
// (status is a Subscribing-domain fact -- moved off pushProgress entirely, see below).

test('write flow - subscribe([{pluginEntryId, status}]) follows and maps status, array in/out', async () => {
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
  const results = await wrapper.subscribe([{ pluginEntryId: 'series-follow', status: 'COMPLETED' }]);

  assert.equal(Array.isArray(results), true);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { pluginEntryId: 'series-follow', success: true, mode: 'subscribed', listId: null });
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

test('write flow - subscribe() with no status still follows, no status POST at all', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const results = await wrapper.subscribe([{ pluginEntryId: 'series-follow-only' }]);

  assert.deepEqual(results, [{ pluginEntryId: 'series-follow-only', success: true, mode: 'subscribed', listId: null }]);
  assert.equal(httpHooks.postCalls.some((c) => String(c.url).endsWith('/status')), false);
});

test('write flow - subscribe() batches multiple entries independently, one failure never blocks the rest', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const results = await wrapper.subscribe([
    { pluginEntryId: 'series-a', status: 'READING' },
    { pluginEntryId: '', status: 'READING' }, // invalid -- missing pluginEntryId
    { pluginEntryId: 'series-c', status: 'COMPLETED' },
  ]);

  assert.equal(results.length, 3);
  assert.equal(results[0].success, true);
  assert.equal(results[0].pluginEntryId, 'series-a');
  assert.equal(results[1].success, false);
  assert.equal(typeof results[1].error, 'string');
  assert.equal(results[2].success, true);
  assert.equal(results[2].pluginEntryId, 'series-c');
});

// host-capability-contract.md §2's sync.push mapping -- array-shaped pushProgress(). Status is no
// longer accepted here at all (moved to subscribe() above); only rating is actionable.

test('write flow - pushProgress([{pluginEntryId, chapter}]) fails cleanly, no rating present', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({
    status: 200,
    data: { access_token: 'write-access', refresh_token: 'write-refresh' },
  });

  const wrapper = await createWrapper(client, context);
  const results = await wrapper.pushProgress([{ pluginEntryId: 'series-1', chapter: 10 }]);

  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.equal(typeof results[0].error, 'string');
});

test('write flow - pushProgress() with a status field is a no-op for status -- never posts to the status endpoint', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  // A stray `status` field (e.g. a caller that hasn't fully migrated) is silently ignored --
  // pushProgress() no longer reads it at all, and with no rating present this fails cleanly.
  const results = await wrapper.pushProgress([{ pluginEntryId: 'series-progress', status: 'READING' }]);

  assert.equal(results[0].success, false);
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/manga/series-progress/status')), false);
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
  const results = await wrapper.pushProgress([{ pluginEntryId: 'series-progress', rating: 0 }]);

  assert.equal(results[0].success, true);
  assert.deepEqual(results[0].updatedFields, ['rating']);
  assert.ok(httpHooks.deleteCalls.some((c) => String(c.url).endsWith('/rating/series-progress')), 'expected a DELETE, not a POST, for rating:0');
  assert.equal(httpHooks.postCalls.some((c) => String(c.url).endsWith('/rating/series-progress')), false);
});

test('write flow - pushProgress with only rating succeeds, chapter/volume always ignored (no such MangaDex API)', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: { result: 'ok' } };
  };

  const wrapper = await createWrapper(client, context);
  const results = await wrapper.pushProgress([{ pluginEntryId: 'series-progress', chapter: 42, volume: 3, rating: 9 }]);

  assert.equal(results[0].success, true);
  assert.deepEqual(results[0].updatedFields, ['rating']);
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/manga/series-progress/status')), false);
  assert.equal(httpHooks.postCalls.some((call) => String(call.url).endsWith('/rating/series-progress')), true);
});

test('write flow - pushProgress() batches multiple entries independently, one failure never blocks the rest', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: { result: 'ok' } };
  };

  const wrapper = await createWrapper(client, context);
  const results = await wrapper.pushProgress([
    { pluginEntryId: 'series-a', rating: 7 },
    { pluginEntryId: 'series-b', chapter: 5 }, // invalid -- no rating, chapter alone is never actionable
    { pluginEntryId: 'series-c', rating: 8 },
  ]);

  assert.equal(results.length, 3);
  assert.equal(results[0].success, true);
  assert.equal(results[0].pluginEntryId, 'series-a');
  assert.equal(results[1].success, false);
  assert.equal(results[2].success, true);
  assert.equal(results[2].pluginEntryId, 'series-c');
});

test('write flow - pushProgress with no rating fails cleanly', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, context);
  const results = await wrapper.pushProgress([{ pluginEntryId: 'series-progress', chapter: 5 }]);

  assert.equal(results[0].success, false);
  assert.equal(typeof results[0].error, 'string');
});

// host-capability-contract.md §2.1 -- subscribe.remove's array-shaped unsubscribe(), a thin
// wrapper looping over unfollowManga(). Required, not optional: the host's real dispatch
// (ApiPluginHandler._performUnsubscribe()) already calls instance.unsubscribe(...) by that exact
// literal name -- before this method existed, MangaDex had no way to unsubscribe through it.

test('write flow - unsubscribe([id]) calls unfollowManga and reports success', async () => {
  const { context, hooks: cacheHooks } = createMockContext({ 'mangadex_readingStatus_series-unsub': 'reading' });
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const results = await wrapper.unsubscribe(['series-unsub']);

  assert.deepEqual(results, [{ pluginEntryId: 'series-unsub', success: true }]);
  assert.equal(httpHooks.deleteCalls.some((c) => String(c.url).endsWith('/manga/series-unsub/follow')), true);
  assert.equal(cacheHooks.data.has('mangadex_readingStatus_series-unsub'), false);
});

test('write flow - unsubscribe() batches multiple ids independently, one failure never blocks the rest', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return { status: 200, data: { access_token: 'write-access', refresh_token: 'write-refresh' } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const results = await wrapper.unsubscribe(['series-a', '', 'series-c']);

  assert.equal(results.length, 3);
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false);
  assert.equal(typeof results[1].error, 'string');
  assert.equal(results[2].success, true);
});
