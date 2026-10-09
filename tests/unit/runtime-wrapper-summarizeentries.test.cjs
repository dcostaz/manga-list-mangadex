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
 * watch.summary -> summarizeEntries(). Array in, array out, per-entry failure
 * (host-capability-contract.md §2.1), reusing getMangaByIds() -- the same batched manga-detail
 * fetch getReadingList() already uses -- rather than one queryLive() call per id. Stubs
 * getMangaByIds() directly, same approach runtime-wrapper-querylive.test.cjs already uses for
 * queryLive's own getSeriesById/getSeriesUrl.
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
    client_id: 'client-id',
    client_secret: 'client-secret',
  });
  return wrapper;
}

test('summarizeEntries: array in, array out, in request order', async () => {
  const wrapper = await createWrapper();
  wrapper.getMangaByIds = async (ids) => {
    assert.deepEqual(ids, ['id-1', 'id-2']);
    return [
      { id: 'id-1', attributes: { status: 'ongoing' } },
      { id: 'id-2', attributes: { status: 'completed' } },
    ];
  };

  const out = await wrapper.summarizeEntries(['id-1', 'id-2']);
  assert.ok(Array.isArray(out), 'array out, not a map (host-capability-contract.md §2.1)');
  assert.deepEqual(out.map((r) => r.pluginEntryId), ['id-1', 'id-2']);
  assert.equal(out[0].success, true);
  assert.equal(out[0].summary.linkState, 'active');
  assert.equal(out[0].summary.label, 'Ongoing');
  assert.equal(out[1].summary.label, 'Completed');
});

test('summarizeEntries: an id absent from the manga rows is an explicit answer (success:true, linkState error)', async () => {
  const wrapper = await createWrapper();
  wrapper.getMangaByIds = async () => []; // removed/deleted manga -- no row returned

  const out = await wrapper.summarizeEntries(['gone-id']);
  assert.equal(out.length, 1);
  assert.equal(out[0].pluginEntryId, 'gone-id');
  assert.equal(out[0].success, true, 'the plugin answered -- the entry is just gone');
  assert.equal(out[0].summary.linkState, 'error');
  assert.match(out[0].summary.label, /gone-id/);
});

test('summarizeEntries: a thrown getMangaByIds degrades to per-entry success:false, never a whole-batch throw', async () => {
  const wrapper = await createWrapper();
  wrapper.getMangaByIds = async () => { throw new Error('network down'); };

  const out = await wrapper.summarizeEntries(['id-1', 'id-2']);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.success === false));
  assert.ok(out.every((r) => typeof r.error === 'string' && r.error.includes('network down')));
});

test('summarizeEntries: an empty request is an empty array, never a throw', async () => {
  const wrapper = await createWrapper();
  assert.deepEqual(await wrapper.summarizeEntries([]), []);
  assert.deepEqual(await wrapper.summarizeEntries(undefined), []);
});
