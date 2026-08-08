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

async function createWrapper() {
  return MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
    },
  });
}

test('compareProgress: chapter comparison is always null — MangaDex has no series-level chapter concept, never guessed', async () => {
  const wrapper = await createWrapper();
  const result = wrapper.compareProgress({ chapter: 45 }, { chapter: 46 });
  assert.equal(result.chapterAhead, null);
  assert.equal(result.chapterBehindOrEqual, null);
});

test('compareProgress: ratingDiffers rounds the host side before comparing (MangaDex rating is a strict integer 1-10)', async () => {
  const wrapper = await createWrapper();
  // Host 8.5 rounds to 9 (or 8, depending on rounding), matching updateRating()'s
  // own Math.round — must not report a spurious mismatch against a remote 9.
  assert.equal(wrapper.compareProgress({ rating: 8.5 }, { rating: 9 }).ratingDiffers, false);
  assert.equal(wrapper.compareProgress({ rating: 8.4 }, { rating: 8 }).ratingDiffers, false);
  assert.equal(wrapper.compareProgress({ rating: 8 }, { rating: 9 }).ratingDiffers, true);
});

test('compareProgress: ratingDiffers handles a missing side without inventing a value', async () => {
  const wrapper = await createWrapper();
  assert.equal(wrapper.compareProgress({ rating: null }, { rating: null }).ratingDiffers, null);
  assert.equal(wrapper.compareProgress({ rating: 8 }, {}).ratingDiffers, true);
});

test('compareProgress: statusDiffers compares .status directly', async () => {
  const wrapper = await createWrapper();
  assert.equal(wrapper.compareProgress({ status: 'READING' }, { status: 'READING' }).statusDiffers, false);
  assert.equal(wrapper.compareProgress({ status: 'READING' }, { status: 'ON_HOLD' }).statusDiffers, true);
  assert.equal(wrapper.compareProgress({}, {}).statusDiffers, null);
});
