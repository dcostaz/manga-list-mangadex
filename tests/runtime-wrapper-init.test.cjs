'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const MangaDexAPIWrapper = require(path.join(
  __dirname,
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
  'scripts',
  'build-runtime-tracker-package.cjs',
));

function createMockHttpClient() {
  const hooks = {
    onFulfilled: null,
    onRejected: null,
    postCalls: [],
  };

  const client = {
    interceptors: {
      response: {
        use(onFulfilled, onRejected) {
          hooks.onFulfilled = onFulfilled;
          hooks.onRejected = onRejected;
          return 0;
        },
      },
    },
    async post(url, payload) {
      hooks.postCalls.push({ url, payload });
      return {
        data: {
          access_token: 'init-token',
          refresh_token: 'init-refresh',
        },
      };
    },
  };

  return { client, hooks };
}

async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'manga-list-mangadex-wave1-test-'));
}

test('init path - serviceSettings resolve from apiSettings when not provided directly', async () => {
  const effective = buildEffectiveSettingsDocument();
  const tempDir = await createTempDir();
  const settingsPath = path.join(tempDir, 'effective-settings.json');
  await fs.writeFile(settingsPath, JSON.stringify(effective, null, 2), 'utf8');

  try {
    const { client } = createMockHttpClient();
    const wrapper = await MangaDexAPIWrapper.init({
      settingsPath,
      httpClient: client,
    });

    assert.equal(wrapper.settings['api.baseUrl'], 'https://api.mangadex.org');
    assert.equal(typeof wrapper.onCredentialsRequired, 'function');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('init path - serviceSettings override apiSettings legacy payload', async () => {
  const { client } = createMockHttpClient();
  const wrapper = await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://override.example',
      'api.endpoints.token.template': '${baseUrl}/token',
    },
    httpClient: client,
  });

  assert.equal(wrapper.settings['api.baseUrl'], 'https://override.example');
});

test('interceptor - HTML response errors are normalized into infrastructure errors', async () => {
  const { client, hooks } = createMockHttpClient();
  await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${baseUrl}/token',
    },
    httpClient: client,
  });

  assert.equal(typeof hooks.onRejected, 'function');

  await assert.rejects(
    async () => hooks.onRejected({
      response: {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        data: '<html><head><title>Service Unavailable</title></head><body>Down</body></html>',
      },
    }),
    (error) => {
      assert.equal(error.name, 'MangaDexBackendError');
      assert.equal(error.isInfrastructureError, true);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /infrastructure error/i);
      return true;
    },
  );
});

test('interceptor - non HTML errors pass through untouched', async () => {
  const { client, hooks } = createMockHttpClient();
  await MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${baseUrl}/token',
    },
    httpClient: client,
  });

  const originalError = {
    response: {
      status: 400,
      headers: { 'content-type': 'application/json' },
      data: { error: 'bad request' },
    },
  };

  await assert.rejects(
    async () => hooks.onRejected(originalError),
    (error) => {
      assert.equal(error, originalError);
      return true;
    },
  );
});

test('runtime contract - serviceName static getter remains stable', () => {
  assert.equal(MangaDexAPIWrapper.serviceName, 'mangadex');
});
