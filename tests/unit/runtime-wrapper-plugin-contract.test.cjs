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
      'api.endpoints.status.template': '${baseUrl}/manga/${id}/status',
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

const tokenPostHandler = () => ({
  status: 200,
  data: { access_token: 'contract-access', refresh_token: 'contract-refresh' },
});

// ---------------------------------------------------------------------------
// findMatches() — localtracker.enrich
// ---------------------------------------------------------------------------

test('findMatches - normalizes search() results to PluginMatchCandidate shape', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = tokenPostHandler;
  httpHooks.getHandler = (url) => {
    const value = String(url);
    if (value.endsWith('/manga')) {
      return {
        status: 200,
        data: {
          data: [{
            id: 'match-1',
            type: 'manga',
            attributes: {
              title: { en: 'Solo Leveling' },
              altTitles: [{ ko: 'Na Honjaman Level Up' }],
              description: {},
            },
            relationships: [],
          }],
          included: [],
        },
      };
    }
    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const matches = await wrapper.findMatches('Solo Leveling');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].pluginEntryId, 'match-1');
  assert.equal(matches[0].title, 'Solo Leveling');
  assert.equal(typeof matches[0].confidence, 'number');
});

test('findMatches - returns [] for an empty/blank title without calling the API', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  const wrapper = await createWrapper(client, context);
  const matches = await wrapper.findMatches('   ');

  assert.deepEqual(matches, []);
  assert.equal(httpHooks.getCalls.length, 0);
});

test('findMatches - fails open to [] when search() throws', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = tokenPostHandler;
  httpHooks.getHandler = () => {
    throw new Error('network down');
  };

  const wrapper = await createWrapper(client, context);
  const matches = await wrapper.findMatches('Anything');

  assert.deepEqual(matches, []);
});

// ---------------------------------------------------------------------------
// buildLinkContribution() / syncEnrichment() — localtracker.enrich
// ---------------------------------------------------------------------------

test('buildLinkContribution - full shape with sourceLinks and mapped seriesStatus', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = tokenPostHandler;
  httpHooks.getHandler = (url) => {
    const value = String(url);
    if (value.includes('/manga/series-42')) {
      return {
        status: 200,
        data: {
          data: {
            id: 'series-42',
            type: 'manga',
            attributes: {
              title: { en: 'Chainsaw Man' },
              altTitles: [{ ja: 'チェンソーマン' }],
              description: { en: 'A devil hunter story.' },
              status: 'ongoing',
              year: 2018,
              tags: [{ attributes: { name: { en: 'Action' }, group: 'genre' } }],
            },
            relationships: [],
          },
          included: [],
        },
      };
    }
    if (value.endsWith('/cover')) {
      return { status: 200, data: { data: [] } };
    }
    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const contribution = await wrapper.buildLinkContribution('series-42');

  assert.equal(contribution.pluginEntryId, 'series-42');
  assert.equal(contribution.displayTitle, 'Chainsaw Man');
  assert.equal(contribution.seriesStatus, 'ongoing');
  assert.equal(typeof contribution.syncedAt, 'string');
  assert.equal(contribution.sourceLinks.length, 1);
  assert.equal(contribution.sourceLinks[0].seriesUrl, 'https://mangadex.org/title/series-42');
  assert.equal(contribution.sourceLinks[0].isPrimary, true);
});

test('buildLinkContribution - returns null when the series is not found', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = tokenPostHandler;
  httpHooks.getHandler = () => ({ status: 200, data: {} });

  const wrapper = await createWrapper(client, context);
  const contribution = await wrapper.buildLinkContribution('missing-series');

  assert.equal(contribution, null);
});

test('syncEnrichment - resolves pluginEntryId from localTrackerEntry.pluginEntryId', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = tokenPostHandler;
  httpHooks.getHandler = (url) => {
    if (String(url).includes('/manga/series-7')) {
      return {
        status: 200,
        data: { data: { id: 'series-7', attributes: { title: { en: 'One Piece' } }, relationships: [] }, included: [] },
      };
    }
    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const contribution = await wrapper.syncEnrichment({ pluginEntryId: 'series-7' });

  assert.equal(contribution.pluginEntryId, 'series-7');
  assert.equal(contribution.displayTitle, 'One Piece');
});

test('syncEnrichment - falls back to localTrackerEntry.trackerId when pluginEntryId is absent', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = tokenPostHandler;
  httpHooks.getHandler = (url) => {
    if (String(url).includes('/manga/series-legacy')) {
      return {
        status: 200,
        data: { data: { id: 'series-legacy', attributes: { title: { en: 'Legacy Field' } }, relationships: [] }, included: [] },
      };
    }
    return { status: 200, data: { data: [] } };
  };

  const wrapper = await createWrapper(client, context);
  const contribution = await wrapper.syncEnrichment({ trackerId: 'series-legacy' });

  assert.equal(contribution.pluginEntryId, 'series-legacy');
});

test('syncEnrichment - returns null when neither pluginEntryId nor trackerId is present', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, context);
  const contribution = await wrapper.syncEnrichment({});

  assert.equal(contribution, null);
});

// ---------------------------------------------------------------------------
// pullProgress() — tracker.sync
// ---------------------------------------------------------------------------

test('pullProgress - maps MangaDex reading status to the app ReadingStatus enum', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = tokenPostHandler;
  httpHooks.getHandler = (url) => {
    if (String(url).includes('/status')) {
      return { status: 200, data: { status: 'on_hold' } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const progress = await wrapper.pullProgress('series-9');

  assert.deepEqual(progress, { status: 'ON_HOLD', chapter: null, volume: null });
});

test('pullProgress - returns null when MangaDex has no reading status for the series', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = tokenPostHandler;
  httpHooks.getHandler = (url) => {
    if (String(url).includes('/status')) {
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const progress = await wrapper.pullProgress('series-unfollowed');

  assert.equal(progress, null);
});

// ---------------------------------------------------------------------------
// refreshCredentials()
// ---------------------------------------------------------------------------

test('refreshCredentials - throws when no current credential is supplied', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, context);

  await assert.rejects(() => wrapper.refreshCredentials(null), /current credential is required/);
});

test('refreshCredentials - forces a fresh token and returns a new PluginCredential', async () => {
  const { context } = createMockContext();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).endsWith('/token')) {
      return {
        status: 200,
        data: { access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' },
      };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const refreshed = await wrapper.refreshCredentials({ username: 'demo', password: 'secret' });

  assert.equal(refreshed.token, 'refreshed-access');
  assert.equal(typeof refreshed.expiresAt, 'string');
});
