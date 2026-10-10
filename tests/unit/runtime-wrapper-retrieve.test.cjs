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
 * `Plan-2026Q4-retrieving-ingesting`, Phase 7 — `listChapters()`/`listPages()`/`downloadPage()`.
 * Both real MangaDex endpoints (`GET /manga/{id}/feed`, `GET /at-home/server/{chapterId}`)
 * declare `security: []`, so none of these methods may ever call `getToken()` — every test below
 * that asserts on `httpHooks.getCalls` also asserts no `Authorization` header appears anywhere.
 */

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
    getHandler: () => ({ status: 200, data: {} }),
  };

  const client = {
    interceptors: { response: { use() { return 0; } } },
    async get(url, config) {
      hooks.getCalls.push({ url, config });
      const out = hooks.getHandler(url, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
    },
    async post() {
      throw new Error('No POST expected in retrieve flows (security: [] — no token call)');
    },
  };

  return { client, hooks };
}

async function createWrapper(httpClient, context) {
  return MangaDexAPIWrapper.init({
    serviceSettings: {
      'api.authUrl': 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect',
      'api.baseUrl': 'https://api.mangadex.org',
      'api.endpoints.token.template': '${authUrl}/token',
      'api.endpoints.refreshToken.template': '${authUrl}/token',
      'api.endpoints.manga.template': '${baseUrl}/manga',
      'api.endpoints.feed.template': '${baseUrl}/manga/${id}/feed',
      'api.endpoints.feed.throttle': 0,
      'api.endpoints.atHomeServer.template': '${baseUrl}/at-home/server/${id}',
      'api.endpoints.atHomeServer.throttle': 0,
    },
    httpClient,
    context,
  });
}

function chapterRow({ id, chapter = null, volume = null, title = null, translatedLanguage = 'en', externalUrl = null }) {
  return { id, type: 'chapter', attributes: { chapter, volume, title, translatedLanguage, externalUrl, pages: 5, version: 1 } };
}

function hasAuthHeader(call) {
  const headers = call.config && call.config.headers ? call.config.headers : {};
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

// ---------------------------------------------------------------------------
// listChapters()
// ---------------------------------------------------------------------------

test('listChapters: maps feed rows to {id, label, ordering, language}, never calling getToken()', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/feed')) {
      return {
        status: 200,
        data: {
          data: [
            chapterRow({ id: 'ch-1', chapter: '1', title: 'Beginnings' }),
            chapterRow({ id: 'ch-2', chapter: '2', volume: '1' }),
          ],
          total: 2,
        },
      };
    }
    if (String(url).includes('/manga/')) {
      return { status: 200, data: { data: { id: 'manga-1', attributes: { availableTranslatedLanguages: ['en', 'es'] } } } };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.listChapters('manga-1', { language: 'en' });

  assert.deepEqual(result.chapters, [
    { id: 'ch-1', label: 'Ch. 1 - Beginnings', ordering: 0, language: 'en' },
    { id: 'ch-2', label: 'Vol. 1 Ch. 2', ordering: 1, language: 'en' },
  ]);
  assert.deepEqual(result.availableLanguages, ['en', 'es']);
  assert.equal(hooks.getCalls.every((c) => !hasAuthHeader(c)), true, 'no call in this flow may carry an Authorization header');
});

test('listChapters: excludes chapters with a non-null externalUrl', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/feed')) {
      return {
        status: 200,
        data: {
          data: [
            chapterRow({ id: 'ch-1', chapter: '1' }),
            chapterRow({ id: 'ch-2', chapter: '2', externalUrl: 'https://example.com/read' }),
          ],
          total: 2,
        },
      };
    }
    return { status: 200, data: { data: { attributes: {} } } };
  };

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.listChapters('manga-1');

  assert.deepEqual(result.chapters.map((c) => c.id), ['ch-1']);
});

test('listChapters: defaults language to "en" when the caller supplies none', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/feed')) {
      return { status: 200, data: { data: [], total: 0 } };
    }
    return { status: 200, data: { data: { attributes: {} } } };
  };

  const wrapper = await createWrapper(client, context);
  await wrapper.listChapters('manga-1');

  const feedCall = hooks.getCalls.find((c) => String(c.url).includes('/feed'));
  assert.deepEqual(feedCall.config.params['translatedLanguage[]'], ['en']);
});

test('listChapters: paginates past the 500-row limit using offset', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  const firstPage = Array.from({ length: 500 }, (_, i) => chapterRow({ id: `ch-${i}`, chapter: String(i + 1) }));
  const secondPage = [chapterRow({ id: 'ch-500', chapter: '501' })];

  hooks.getHandler = (url, config) => {
    if (String(url).includes('/feed')) {
      const offset = config.params.offset;
      if (offset === 0) {
        return { status: 200, data: { data: firstPage, total: 501 } };
      }
      return { status: 200, data: { data: secondPage, total: 501 } };
    }
    return { status: 200, data: { data: { attributes: {} } } };
  };

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.listChapters('manga-1');

  assert.equal(result.chapters.length, 501);
  assert.equal(result.chapters[500].id, 'ch-500');
  const feedCalls = hooks.getCalls.filter((c) => String(c.url).includes('/feed'));
  assert.equal(feedCalls.length, 2);
});

test('listChapters: an availableLanguages lookup failure degrades to [], not a thrown error', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/feed')) {
      return { status: 200, data: { data: [chapterRow({ id: 'ch-1', chapter: '1' })], total: 1 } };
    }
    if (String(url).includes('/manga/')) {
      throw new Error('network error');
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.listChapters('manga-1');

  assert.equal(result.chapters.length, 1);
  assert.deepEqual(result.availableLanguages, []);
});

test('listChapters: reuses getMangaById()\'s own cache entry for availableLanguages instead of a second fetch', async () => {
  const { context } = createMockContext({
    mangadex_getMangaById_manga_1: JSON.stringify({ data: { attributes: { availableTranslatedLanguages: ['en', 'fr'] } } }),
  });
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/feed')) {
      return { status: 200, data: { data: [], total: 0 } };
    }
    throw new Error('must not fetch /manga/{id} when the shared cache entry already has it');
  };

  const wrapper = await createWrapper(client, context);
  const result = await wrapper.listChapters('manga_1');

  assert.deepEqual(result.availableLanguages, ['en', 'fr']);
});

test('listChapters: throws when pluginEntryId is missing', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();
  const wrapper = await createWrapper(client, context);

  await assert.rejects(() => wrapper.listChapters(''));
});

// ---------------------------------------------------------------------------
// listPages()
// ---------------------------------------------------------------------------

test('listPages: maps at-home data[] to {pageKey, pageNumber}, full quality only, never calling getToken()', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/at-home/server/')) {
      return {
        status: 200,
        data: { result: 'ok', baseUrl: 'https://cdn.example', chapter: { hash: 'hash-1', data: ['001.jpg', '002.jpg'], dataSaver: ['001-ds.jpg', '002-ds.jpg'] } },
      };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const pages = await wrapper.listPages('manga-1', 'ch-1');

  assert.deepEqual(pages, [{ pageKey: '001.jpg', pageNumber: 0 }, { pageKey: '002.jpg', pageNumber: 1 }]);
  assert.equal(hooks.getCalls.every((c) => !hasAuthHeader(c)), true);
});

test('listPages: throws when chapterId is missing', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();
  const wrapper = await createWrapper(client, context);

  await assert.rejects(() => wrapper.listPages('manga-1', ''));
});

test('listPages: throws a clear error when the at-home response is missing baseUrl/hash', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();
  hooks.getHandler = () => ({ status: 200, data: { result: 'ok' } });

  const wrapper = await createWrapper(client, context);

  await assert.rejects(() => wrapper.listPages('manga-1', 'ch-1'), /Missing baseUrl\/hash/);
});

// ---------------------------------------------------------------------------
// downloadPage()
// ---------------------------------------------------------------------------

test('downloadPage: re-resolves the at-home server and fetches {baseUrl}/data/{hash}/{pageKey}', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/at-home/server/')) {
      return { status: 200, data: { baseUrl: 'https://cdn.example', chapter: { hash: 'hash-1', data: ['001.jpg'] } } };
    }
    if (String(url) === 'https://cdn.example/data/hash-1/001.jpg') {
      return { status: 200, data: Buffer.from('page-bytes') };
    }
    return { status: 200, data: {} };
  };

  const wrapper = await createWrapper(client, context);
  const buffer = await wrapper.downloadPage('manga-1', 'ch-1', '001.jpg');

  assert.equal(Buffer.isBuffer(buffer), true);
  assert.equal(buffer.toString(), 'page-bytes');
  assert.equal(hooks.getCalls.every((c) => !hasAuthHeader(c)), true);
});

test('downloadPage: re-resolves the at-home server on every call, never caching baseUrl/hash across calls', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/at-home/server/')) {
      return { status: 200, data: { baseUrl: 'https://cdn.example', chapter: { hash: 'hash-1', data: ['001.jpg', '002.jpg'] } } };
    }
    return { status: 200, data: Buffer.from('bytes') };
  };

  const wrapper = await createWrapper(client, context);
  await wrapper.downloadPage('manga-1', 'ch-1', '001.jpg');
  await wrapper.downloadPage('manga-1', 'ch-1', '002.jpg');

  const atHomeCalls = hooks.getCalls.filter((c) => String(c.url).includes('/at-home/server/'));
  assert.equal(atHomeCalls.length, 2, 'each downloadPage() call must re-resolve the at-home server, not reuse a cached baseUrl/hash');
});

test('downloadPage: throws on an empty response body', async () => {
  const { context } = createMockContext();
  const { client, hooks } = createMockHttpClient();

  hooks.getHandler = (url) => {
    if (String(url).includes('/at-home/server/')) {
      return { status: 200, data: { baseUrl: 'https://cdn.example', chapter: { hash: 'hash-1', data: ['001.jpg'] } } };
    }
    return { status: 200, data: Buffer.alloc(0) };
  };

  const wrapper = await createWrapper(client, context);

  await assert.rejects(() => wrapper.downloadPage('manga-1', 'ch-1', '001.jpg'), /Empty response body/);
});

test('downloadPage: throws when chapterId or pageKey is missing', async () => {
  const { context } = createMockContext();
  const { client } = createMockHttpClient();
  const wrapper = await createWrapper(client, context);

  await assert.rejects(() => wrapper.downloadPage('manga-1', '', '001.jpg'));
  await assert.rejects(() => wrapper.downloadPage('manga-1', 'ch-1', ''));
});
