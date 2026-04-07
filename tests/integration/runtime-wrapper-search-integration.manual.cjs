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
const {
  buildEffectiveSettingsDocument,
} = require(path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'build-runtime-tracker-package.cjs',
));

const shouldSkip = process.env.ENABLE_REAL_SEARCH_TEST !== '1'
  || process.env.CI === 'true';

function isTruthy(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function buildUrlWithParams(baseUrl, params) {
  if (!params || typeof params !== 'object') {
    return baseUrl;
  }

  const url = new URL(baseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        url.searchParams.append(key, String(entry));
      }
      continue;
    }

    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  }

  return url.toString();
}

function createFetchHttpClient() {
  return {
    interceptors: {
      response: {
        use() {
          return 0;
        },
      },
    },
    async post(url, payload, config = {}) {
      const headers = {
        ...(config.headers || {}),
      };

      let body = payload;
      if (payload instanceof URLSearchParams) {
        body = payload.toString();
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
        body = JSON.stringify(payload);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });

      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (_error) {
        data = rawText;
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    },
    async get(url, config = {}) {
      const resolvedUrl = buildUrlWithParams(url, config.params);
      const response = await fetch(resolvedUrl, {
        method: 'GET',
        headers: {
          ...(config.headers || {}),
        },
      });

      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (_error) {
        data = rawText;
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    },
  };
}

test(
  'interactive search integration - authenticates and fetches live MangaDex search results',
  {
    skip: shouldSkip && 'Set ENABLE_REAL_SEARCH_TEST=1 and run locally (not CI).',
    timeout: 120000,
  },
  async () => {
    const verbose = process.env.MDX_TEST_VERBOSE === undefined || isTruthy(process.env.MDX_TEST_VERBOSE);
    const showFullPayload = isTruthy(process.env.MDX_TEST_SHOW_FULL_SEARCH_PAYLOAD);

    const credentials = {
      username: typeof process.env.MDX_TEST_USERNAME === 'string' ? process.env.MDX_TEST_USERNAME.trim() : '',
      password: typeof process.env.MDX_TEST_PASSWORD === 'string' ? process.env.MDX_TEST_PASSWORD.trim() : '',
      clientId: typeof process.env.MDX_TEST_CLIENT_ID === 'string' ? process.env.MDX_TEST_CLIENT_ID.trim() : '',
      clientSecret: typeof process.env.MDX_TEST_CLIENT_SECRET === 'string' ? process.env.MDX_TEST_CLIENT_SECRET.trim() : '',
    };
    const query = typeof process.env.MDX_TEST_SEARCH_QUERY === 'string' && process.env.MDX_TEST_SEARCH_QUERY.trim()
      ? process.env.MDX_TEST_SEARCH_QUERY.trim()
      : 'One Piece';

    assert.ok(credentials.username, 'MDX_TEST_USERNAME is required.');
    assert.ok(credentials.password, 'MDX_TEST_PASSWORD is required.');
    assert.ok(credentials.clientId, 'MDX_TEST_CLIENT_ID is required.');
    assert.ok(credentials.clientSecret, 'MDX_TEST_CLIENT_SECRET is required.');

    if (verbose) {
      process.stdout.write(`[search-test] Querying MangaDex for: ${query}\n`);
      process.stdout.write('[search-test] Initializing wrapper and authenticating...\n');
    }

    const effectiveSettings = buildEffectiveSettingsDocument();
    const wrapper = await MangaDexAPIWrapper.init({
      serviceSettings: effectiveSettings.settings,
      httpClient: createFetchHttpClient(),
    });

    await wrapper.setCredentials(credentials);

    const raw = await wrapper.searchTrackersRaw({ title: query }, { useCache: false });

    assert.equal(raw.trackerId, 'mangadex');
    assert.equal(raw.operation, 'searchTrackersRaw');
    assert.equal(Array.isArray(raw.payload.data), true);
    assert.ok(raw.payload.data.length > 0, `Expected at least one search result for query '${query}'.`);

    const first = raw.payload.data[0];
    assert.equal(typeof first.id, 'string');
    assert.ok(first.id.length > 0);
    assert.equal(typeof first.title, 'string');
    assert.ok(first.title.length > 0);

    if (verbose) {
      process.stdout.write(`[search-test] Result count: ${raw.payload.data.length}\n`);
      process.stdout.write(`[search-test] First result: ${first.id} | ${first.title}\n`);
      if (showFullPayload) {
        process.stdout.write(`${JSON.stringify(raw.payload, null, 2)}\n`);
      }
      process.stdout.write('[search-test] Search integration test completed successfully.\n');
    }
  },
);
