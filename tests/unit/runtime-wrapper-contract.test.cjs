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
const MangaDexAPISettings = require(path.join(
  __dirname,
  '..',
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangadex',
  'api-settings-mangadex.cjs',
));

test('wrapper contract - init preserves instance and settings payload', async () => {
  const apiSettings = await MangaDexAPISettings.init({
    defaultSettings: {
      'api.baseUrl': 'https://api.mangadex.org',
    },
  });

  const wrapper = await MangaDexAPIWrapper.init({
    apiSettings,
    serviceSettings: {
      featureFlags: {
        search: true,
      },
    },
  });

  assert.ok(wrapper instanceof MangaDexAPIWrapper);
  assert.equal(wrapper.apiSettings, apiSettings);
  assert.deepEqual(wrapper.settings, {
    featureFlags: {
      search: true,
    },
  });
});

test('wrapper contract - init normalizes invalid option shapes', async () => {
  const wrapper = await MangaDexAPIWrapper.init({
    apiSettings: { not: 'an-instance' },
    serviceSettings: 'invalid-shape',
  });

  assert.equal(wrapper.apiSettings, null);
  assert.deepEqual(wrapper.settings, {});
});

test('wrapper contract - raw entity methods provide fallback-safe payloads', async () => {
  const wrapper = await MangaDexAPIWrapper.init();

  wrapper.getMangaById = async () => ({ data: null, includes: [] });
  wrapper.getReadingStatus = async () => null;

  const seriesRaw = await wrapper.getSeriesByIdRaw('series-unknown');
  assert.equal(seriesRaw.operation, 'getSeriesByIdRaw');
  assert.equal(seriesRaw.payload.id, 'series-unknown');
  assert.equal(seriesRaw.payload.title, '');

  const progressRaw = await wrapper.getUserProgressRaw(null);
  assert.equal(progressRaw.operation, 'getUserProgressRaw');
  assert.equal(progressRaw.payload.trackerId, '');
  assert.equal(progressRaw.payload.status, null);
  assert.equal(progressRaw.payload.chapter, null);
  assert.equal(progressRaw.payload.volume, null);
  assert.equal(progressRaw.payload.rating, null);
});

test('wrapper contract - serviceName remains runtime module stable', () => {
  assert.equal(MangaDexAPIWrapper.serviceName, 'mangadex');
});
