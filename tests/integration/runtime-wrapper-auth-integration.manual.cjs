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

const shouldSkip = process.env.ENABLE_REAL_AUTH_TEST !== '1'
  || process.env.CI === 'true';

function isTruthy(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function maskToken(token) {
  if (token.length <= 12) {
    return `${token.slice(0, 2)}...`;
  }

  return `${token.slice(0, 6)}...${token.slice(-4)}`;
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
  };
}

test(
  'interactive auth integration - requests temporary credentials and fetches a real access token',
  {
    skip: shouldSkip && 'Set ENABLE_REAL_AUTH_TEST=1 and run locally (not CI).',
    timeout: 120000,
  },
  async () => {
    const verbose = process.env.MDX_TEST_VERBOSE === undefined || isTruthy(process.env.MDX_TEST_VERBOSE);
    const showFullToken = isTruthy(process.env.MDX_TEST_SHOW_FULL_TOKEN);

    process.stdout.write('This test uses real MangaDex credentials and performs a live auth request.\n');
    process.stdout.write('Use a temporary test account and rotate credentials after use.\n\n');

    const credentials = {
      username: typeof process.env.MDX_TEST_USERNAME === 'string' ? process.env.MDX_TEST_USERNAME.trim() : '',
      password: typeof process.env.MDX_TEST_PASSWORD === 'string' ? process.env.MDX_TEST_PASSWORD.trim() : '',
      clientId: typeof process.env.MDX_TEST_CLIENT_ID === 'string' ? process.env.MDX_TEST_CLIENT_ID.trim() : '',
      clientSecret: typeof process.env.MDX_TEST_CLIENT_SECRET === 'string' ? process.env.MDX_TEST_CLIENT_SECRET.trim() : '',
    };

    assert.ok(credentials.username, 'MDX_TEST_USERNAME is required.');
    assert.ok(credentials.password, 'MDX_TEST_PASSWORD is required.');
    assert.ok(credentials.clientId, 'MDX_TEST_CLIENT_ID is required.');
    assert.ok(credentials.clientSecret, 'MDX_TEST_CLIENT_SECRET is required.');

    if (verbose) {
      process.stdout.write('[auth-test] Credential source: environment variables (runner-provided).\n');
      process.stdout.write('[auth-test] Requesting MangaDex access token using password grant flow...\n');
    }

    const effectiveSettings = buildEffectiveSettingsDocument();
    const wrapper = await MangaDexAPIWrapper.init({
      serviceSettings: effectiveSettings.settings,
      httpClient: createFetchHttpClient(),
    });

    await wrapper.setCredentials(credentials);
    const token = await wrapper.getToken(true);

    assert.equal(typeof token, 'string');
    assert.ok(token.length > 0, 'Expected non-empty access token from live auth call.');

    if (verbose) {
      const renderedToken = showFullToken ? token : maskToken(token);
      process.stdout.write(`[auth-test] Access token generated (length=${token.length}): ${renderedToken}\n`);
      process.stdout.write('[auth-test] Auth integration test completed successfully.\n');
    }
  },
);
