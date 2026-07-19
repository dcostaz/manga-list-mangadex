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
 * Plan-2026Q3-property-modal-delete-actions, Phase 9, Step 9.4: queryLive
 * coverage for MangaDex. queryLive is a thin wrapper around the existing
 * getSeriesById(id, useCache=false) + getSeriesUrl(id) calls, so these tests
 * stub those two methods directly rather than mocking the HTTP layer again.
 */

async function createWrapper() {
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
    httpClient: {
      interceptors: { response: { use: () => 0 } },
      get: async () => ({ data: {} }),
      post: async () => ({ data: {} }),
    },
    context: {
      utils: { sanitizeForSearch: (s) => String(s || '') },
      cache: { getValue: async () => null, setValue: async () => {}, deleteValue: async () => {} },
    },
  });
  await wrapper.setCredentials({
    username: 'demo',
    password: 'secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  return wrapper;
}

test('queryLive: status ok when getSeriesById resolves a series', async () => {
  const wrapper = await createWrapper();
  wrapper.getSeriesById = async (id, useCache) => {
    assert.equal(useCache, false, 'queryLive must bypass the cache');
    return {
      title: 'Chainsaw Man',
      alternativeTitles: ['CSM'],
      metadata: { status: 'ongoing', type: 'Manga', year: 2018 },
    };
  };
  wrapper.getSeriesUrl = async () => 'https://mangadex.org/title/abc';

  const result = await wrapper.queryLive('abc');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.pluginEntryId, 'abc');
  assert.equal(result.data.displayTitle, 'Chainsaw Man');
  assert.equal(result.data.linkState, 'active');
  assert.equal(typeof result.data.fetchedAt, 'string');
  const statGrid = result.data.sections.find((s) => s.type === 'stat-grid');
  assert.ok(statGrid, 'expected a stat-grid section');
  assert.equal(statGrid.fields['Series status'], 'ongoing');
  const linkList = result.data.sections.find((s) => s.type === 'link-list');
  assert.ok(linkList, 'expected a link-list section when getSeriesUrl succeeds');
  assert.equal(linkList.links[0].url, 'https://mangadex.org/title/abc');
});

test('queryLive: status not_found when getSeriesById resolves null', async () => {
  const wrapper = await createWrapper();
  wrapper.getSeriesById = async () => null;

  const result = await wrapper.queryLive('missing-id');
  assert.deepEqual(result, { status: 'not_found' });
});

test('queryLive: status error (retryable) when getSeriesById throws', async () => {
  const wrapper = await createWrapper();
  wrapper.getSeriesById = async () => { throw new Error('network unreachable'); };

  const result = await wrapper.queryLive('abc');
  assert.equal(result.status, 'error');
  assert.equal(result.message, 'network unreachable');
  assert.equal(result.retryable, true);
});

test('queryLive: tolerates getSeriesUrl failure without failing the whole call', async () => {
  const wrapper = await createWrapper();
  wrapper.getSeriesById = async () => ({ title: 'Chainsaw Man', metadata: {} });
  wrapper.getSeriesUrl = async () => { throw new Error('url resolution failed'); };

  const result = await wrapper.queryLive('abc');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.sections.some((s) => s.type === 'link-list'), false);
});
