'use strict';

/**
 * Live checks against api.mangadex.org — run by hand, never in CI (Plan-2026Q4-tracker-plugin-standardization,
 * Phase 4: "the manual integration tests are kept and run once"). Read-only: nothing here follows, rates or sets a
 * status. MangaDex search is authenticated (owner ruling 2026-07-17), so the search and library checks need a
 * personal API client; the chapter check is anonymous, as Retrieving calls it.
 *
 *   ENABLE_REAL_SEARCH_TEST=1 MDX_TEST_USERNAME=… MDX_TEST_PASSWORD=… MDX_TEST_CLIENT_ID=… MDX_TEST_CLIENT_SECRET=… \
 *     [MDX_TEST_SEARCH_QUERY="..."] npm run test:integration
 *   ENABLE_REAL_LIBRARY_TEST=1 MDX_TEST_USERNAME=… (the same four) npm run test:integration
 *   ENABLE_REAL_RETRIEVE_TEST=1 [MDX_TEST_MANGA_ID=<uuid>] npm run test:integration
 *
 * The plugin is built exactly as the host builds it; its HTTP client is Node's fetch behind an axios-shaped
 * adapter, so the run needs no dependency.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');

const tracker = locateTracker();
const descriptor = require(path.join(tracker.dir, `plugin-${tracker.id}.cjs`));
const settings = JSON.parse(fs.readFileSync(path.join(tracker.dir, `${tracker.id}-api-settings.values.json`), 'utf8')).settings;

const env = (/** @type {string} */ name) => (typeof process.env[name] === 'string' ? String(process.env[name]).trim() : '');
const credential = {
    username: env('MDX_TEST_USERNAME'),
    password: env('MDX_TEST_PASSWORD'),
    client_id: env('MDX_TEST_CLIENT_ID'),
    client_secret: env('MDX_TEST_CLIENT_SECRET'),
};
const hasCredential = Object.values(credential).every(Boolean);
const inCi = process.env.CI === 'true';
const searchSkip = env('ENABLE_REAL_SEARCH_TEST') !== '1' || inCi || !hasCredential;
const librarySkip = env('ENABLE_REAL_LIBRARY_TEST') !== '1' || inCi || !hasCredential;
const retrieveSkip = env('ENABLE_REAL_RETRIEVE_TEST') !== '1' || inCi;

/** An axios-shaped client over fetch: request(config) → { status, data, headers }, throws with `response` ≥ 400. */
const fetchAxios = {
    /** @param {Record<string, any>} config */
    async request(config) {
        const url = new URL(config.url);
        for (const [key, value] of Object.entries(config.params || {})) {
            if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
            else if (value !== undefined) url.searchParams.set(key, String(value));
        }
        /** @type {Record<string, string>} */
        const headers = { ...(config.headers || {}) };
        let body;
        if (typeof config.data === 'string') {
            body = config.data;
        } else if (config.data !== undefined && config.data !== null) {
            body = JSON.stringify(config.data);
            if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
        }
        const response = await fetch(url, {
            method: String(config.method || 'get').toUpperCase(),
            headers,
            body,
            signal: config.signal || AbortSignal.timeout(config.timeout || 30000),
        });
        const responseHeaders = Object.fromEntries(response.headers.entries());
        const data = config.responseType === 'arraybuffer'
            ? Buffer.from(await response.arrayBuffer())
            : (responseHeaders['content-type'] || '').includes('json') ? await response.json() : await response.text();
        const out = { status: response.status, data, headers: responseHeaders, config };
        if (response.status >= 400) {
            const error = new Error(`Request failed with status code ${response.status}`);
            /** @type {any} */ (error).response = out;
            throw error;
        }
        return out;
    },
};

async function plugin() {
    return descriptor.WrapperClass.init({ context: { utils: {}, http: fetchAxios, cache: null }, serviceSettings: settings });
}

/** @param {unknown} cred @param {string} scope */
const context = (cred, scope) => ({ credential: cred, identity: `manual-${scope}`, scope, signal: null });

test('live: the credential tests good; search answers candidates with a 0–1 confidence and a canonical URL; lookup and summary agree', { skip: searchSkip }, async () => {
    const instance = await plugin();
    assert.equal(await instance.testCredentials(credential), true);
    const results = await instance.search(env('MDX_TEST_SEARCH_QUERY') || 'Frieren', undefined, context(credential, 'system'));
    assert.ok(results.length > 0, 'at least one candidate');
    for (const r of results) {
        assert.ok(r.confidence >= 0 && r.confidence <= 1);
        assert.match(String(r.canonicalUrl), /^https:\/\/mangadex\.org\/title\//);
    }
    const detail = await instance.lookup(results[0].pluginEntryId, context(credential, 'system'));
    assert.equal(detail.pluginEntryId, results[0].pluginEntryId);
    const summary = await instance.summarizeEntries([results[0].pluginEntryId], context(credential, 'system'));
    assert.equal(summary[0].success, true);
    console.log(`search: ${results.length} candidates; first '${results[0].title}' (${results[0].pluginEntryId}), authors ${JSON.stringify(detail.authors || [])}, status ${summary[0].summary.status}`);
});

test('live: the whole followed list comes back with MangaDex\'s own status tokens', { skip: librarySkip }, async () => {
    const instance = await plugin();
    const list = await instance.getReadingList(context(credential, 'user'));
    const tokens = new Set(list.map((/** @type {any} */ e) => e.status));
    for (const token of tokens) {
        if (token !== null) assert.ok(token in tracker.manifest.syncOptions.statusVocabulary.pull, `'${token}' is in the pull table`);
    }
    const titled = list.filter((/** @type {any} */ e) => e.title !== null).length;
    console.log(`library: ${list.length} entries (${titled} titled; more than 100 proves the ids[] chunking), statuses seen: ${[...tokens].join(', ')}`);
});

test('live: chapters and pages anonymously, as Retrieving calls them', { skip: retrieveSkip }, async () => {
    const instance = await plugin();
    const id = env('MDX_TEST_MANGA_ID') || 'a96676e5-8ae2-425e-b549-7f15dd34a6d8'; // Komi Can't Communicate
    const list = await instance.listChapters(id, { language: 'en' }, context(null, 'user'));
    assert.ok(list.chapters.length > 0, 'at least one chapter');
    assert.ok(list.availableLanguages.includes('en'));
    const pages = await instance.listPages(id, list.chapters[0].id, context(null, 'user'));
    assert.ok(pages.length > 0);
    console.log(`retrieve: ${list.chapters.length} chapters, first '${list.chapters[0].label}' with ${pages.length} pages; languages ${list.availableLanguages.join(', ')}`);
});
