'use strict';

/**
 * MangaDex's client, through the plugin the SDK builds, against the fixture source: the source calls, their
 * fields, the password/refresh grants and the failures. Ported from the 3.x wrapper's token, read, readinglist,
 * write, retrieve, search-cover, querylive and summarizeentries tests (their source facts are kept; what the SDK now
 * owns — the token cache, the one 401 replay, retry, throttle — is tested in the SDK, and here only as MangaDex uses it).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createStubAxios, createStubContext, callContext } = require('@manga-list/plugin-sdk/testing');
const { isPluginError } = require('@manga-list/plugin-sdk');
const { locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');
const { createSource, ACCOUNTS, BASE, AUTH, AT_HOME, mangaId, chapterId, manga, LIBRARY_SIZE } = require('../fixtures/mangadex-source.cjs');
const { htmlNormalizer } = require('../../src/runtime/apiwrappers/reg-mangadex/client-mangadex.cjs');

const tracker = locateTracker();
const descriptor = require(path.join(tracker.dir, `plugin-${tracker.id}.cjs`));
const values = JSON.parse(fs.readFileSync(path.join(tracker.dir, `${tracker.id}-api-settings.values.json`), 'utf8')).settings;

const ID1 = mangaId(1);
const ID2 = mangaId(2);
const MISSING = mangaId(901);

/** @param {Record<string, unknown>} [overrides] */
const user = (overrides = {}) => callContext({ credential: ACCOUNTS.alpha, identity: 'slot-a', scope: 'user-a', ...overrides });
const system = () => callContext({ credential: ACCOUNTS.alpha, identity: 'system-slot', scope: 'system' });
const anonymous = () => callContext({ credential: null, identity: 'anonymous', scope: 'user-a' });

/**
 * @param {(config: Record<string, any>, source: ReturnType<typeof createSource>) => any} [around] - answers first; undefined falls through to the source
 * @param {Record<string, unknown>} [extraSettings]
 */
async function plugin(around, extraSettings = {}) {
    /** @type {Record<string, unknown>} */
    const settings = { ...values, 'retry.backoff.initialDelay': 1, 'retry.backoff.maxDelay': 2, 'retry.maxAttempts': 2, 'rateLimit.perEndpoint.defaultDelay': 0, 'rateLimit.global.enabled': false, ...extraSettings };
    for (const key of Object.keys(settings)) if (key.endsWith('.throttle')) settings[key] = 0;
    const source = createSource();
    const axios = createStubAxios((config) => {
        const out = around ? around(config, source) : undefined;
        return out === undefined ? source.handler(config) : out;
    });
    const context = createStubContext({ axios });
    const instance = await descriptor.WrapperClass.init({ context, serviceSettings: settings });
    return { instance, axios, source, cache: /** @type {any} */ (context.cache) };
}

/** @param {any[]} calls @param {string} url */
const callsTo = (calls, url) => calls.filter((c) => c.url === url);
/** @param {Record<string, any>} c */
const form = (c) => new URLSearchParams(String(c.data));
/** @param {unknown} code */
const coded = (code) => (/** @type {unknown} */ e) => isPluginError(e) && e.code === code;

// ── sign-in: the password and refresh grants ─────────────────────────────────

test('sign-in: the password grant is form-encoded with the personal client, and its access token is the Bearer of every call', async () => {
    const { instance, axios } = await plugin();
    await instance.pullProgress(ID1, user());
    await instance.pullProgress(ID2, user());
    const grants = callsTo(axios.calls, `${AUTH}/token`);
    assert.equal(grants.length, 1, 'one sign-in serves later calls under the same identity');
    assert.equal(grants[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(form(grants[0])), { grant_type: 'password', username: 'alpha-reader', password: 'alpha-password', client_id: 'personal-client-alpha', client_secret: 'alpha-secret' });
    const api = axios.calls.filter((c) => String(c.url).startsWith(BASE));
    assert.ok(api.length >= 2 && api.every((c) => /^Bearer access-alpha-reader-\d+$/.test(c.headers.Authorization)));
});

/** Access tokens that live one second (expires_in: 1), so a test can outlive one. @param {Record<string, any>} config @param {ReturnType<typeof createSource>} src */
function shortLived(config, src) {
    if (config.url !== `${AUTH}/token`) return undefined;
    const out = src.handler(config);
    return out.status === 200 ? { ...out, data: { ...out.data, expires_in: 1 } } : out;
}
const outlive = () => new Promise((resolve) => setTimeout(resolve, 600));

test('sign-in: an expired access token is renewed with the refresh grant, never the password', async () => {
    const { instance, source } = await plugin(shortLived);
    await instance.pullProgress(ID1, user());
    await outlive();
    await instance.pullProgress(ID1, user());
    assert.deepEqual(source.grants, ['password', 'refresh']);
});

test('sign-in: a refused refresh falls back to the password grant', async () => {
    const { instance, source } = await plugin((config, src) => {
        if (config.url === `${AUTH}/token` && form(config).get('grant_type') === 'refresh_token') {
            src.grants.push('refresh-refused');
            return { status: 400, data: { error: 'invalid_grant' } };
        }
        return shortLived(config, src);
    });
    await instance.pullProgress(ID1, user());
    await outlive();
    const out = await instance.pullProgress(ID1, user());
    assert.equal(out.status, 'reading');
    assert.deepEqual(source.grants, ['password', 'refresh-refused', 'password']);
});

test('sign-in: a token MangaDex rejects (401) is replaced by a fresh password grant and the call replayed once', async () => {
    let revoked = '';
    const { instance, source } = await plugin((config) => {
        const bearer = config.headers && config.headers.Authorization;
        return revoked && bearer === `Bearer ${revoked}` ? { status: 401, data: {} } : undefined;
    });
    await instance.pullProgress(ID1, user());
    revoked = [...source.access.keys()][0];
    assert.equal((await instance.pullProgress(ID1, user())).status, 'reading');
    assert.deepEqual(source.grants, ['password', 'password']);
});

test('sign-in: a second 401 fails as credential_rejected without looping; another failure never signs in again', async () => {
    const { instance, source } = await plugin((config) => (config.url === `${BASE}/manga/status` ? { status: 401, data: {} } : undefined));
    await assert.rejects(instance.getReadingList(user()), coded('credential_rejected'));
    assert.deepEqual(source.grants, ['password', 'password'], 'one re-sign-in, one replay');
    const other = await plugin((config) => (config.url === `${BASE}/manga/status` ? { status: 500, data: {} } : undefined));
    await assert.rejects(other.instance.getReadingList(user()), coded('source_error'));
    assert.deepEqual(other.source.grants, ['password']);
});

test('sign-in: another identity never gets the previous identity\'s token', async () => {
    const { instance, axios } = await plugin();
    await instance.pullProgress(ID1, user());
    const mark = axios.calls.length;
    await instance.pullProgress(ID1, user({ credential: ACCOUNTS.beta, identity: 'slot-b', scope: 'user-b' }));
    const later = axios.calls.slice(mark);
    assert.equal(form(later.find((c) => c.url === `${AUTH}/token`)).get('username'), 'beta-reader');
    assert.ok(later.filter((c) => String(c.url).startsWith(BASE)).every((c) => String(c.headers.Authorization).startsWith('Bearer access-beta-reader-')));
});

test('testCredentials: true for a good account, false for a wrong password or an unknown client, false without a call when fields are missing', async () => {
    const { instance, axios } = await plugin();
    assert.equal(await instance.testCredentials(ACCOUNTS.alpha), true);
    assert.equal(await instance.testCredentials({ ...ACCOUNTS.alpha, password: 'wrong' }), false);
    assert.equal(await instance.testCredentials({ ...ACCOUNTS.alpha, client_secret: 'wrong' }), false);
    const before = axios.calls.length;
    assert.equal(await instance.testCredentials({ username: 'alpha-reader' }), false);
    assert.equal(await instance.testCredentials({}), false);
    assert.equal(axios.calls.length, before);
});

test('testCredentials: a transport failure is a thrown PluginError, never false', async () => {
    const { instance } = await plugin((config) => (config.url === `${AUTH}/token` ? { status: 503, data: {} } : undefined));
    await assert.rejects(instance.testCredentials(ACCOUNTS.alpha), coded('source_error'));
});

// ── search and lookup ────────────────────────────────────────────────────────

test('search is authenticated (owner ruling 2026-07-17) and asks for authors, artists and the cover in the one call', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.search('Series 1', undefined, system());
    const searches = axios.calls.filter((c) => c.url === `${BASE}/manga` && c.params && c.params.title !== undefined);
    assert.equal(searches.length, 1);
    assert.match(searches[0].headers.Authorization, /^Bearer /);
    assert.deepEqual(searches[0].params['includes[]'], ['author', 'artist', 'cover_art']);
    assert.equal(out[0].pluginEntryId, ID1);
    assert.equal(out[0].confidence, 1);
    assert.equal(out[0].canonicalUrl, `https://mangadex.org/title/${ID1}`);
    await assert.rejects(instance.search('Series 1', undefined, anonymous()), coded('credential_rejected'));
});

test('search: an exact title match outranks fuzzy ones, and only exact matches are answered when there is one', async () => {
    const { instance } = await plugin();
    const out = await instance.search('Series 1', undefined, system());
    assert.deepEqual(out.map((/** @type {any} */ c) => c.pluginEntryId), [ID1]);
});

test('search: with no exact match, the rows at or above the fuzzy threshold, best first; below it, nothing', async () => {
    const weak = { ...manga(7), id: 'weak-fuzzy', attributes: { ...manga(7).attributes, title: { en: 'Weak Hero Primary' }, altTitles: [] } };
    const poor = { ...manga(8), id: 'poor', attributes: { ...manga(8).attributes, title: { en: 'Something Else Entirely' }, altTitles: [] } };
    const { instance } = await plugin((config) => (config.url === `${BASE}/manga` && config.params && config.params.title
        ? { status: 200, data: { result: 'ok', data: [poor, weak] } } : undefined));
    const out = await instance.search('Weak Primary', undefined, system());
    assert.deepEqual(out.map((/** @type {any} */ c) => c.pluginEntryId), ['weak-fuzzy']);
    assert.equal(out[0].confidence, 0.67, 'two shared words of three');
});

test('search: a repeat is answered from the cache with its fetch time; refresh asks MangaDex again; a blank query asks nothing', async () => {
    const { instance, axios } = await plugin();
    const live = await instance.search('Series 1', undefined, system());
    assert.equal(live[0].cached, undefined);
    const cached = await instance.search('Series 1', undefined, system());
    assert.equal(cached[0].cached, true);
    assert.equal(typeof cached[0].fetchedAt, 'string');
    const searches = () => axios.calls.filter((c) => c.url === `${BASE}/manga` && c.params && c.params.title !== undefined).length;
    assert.equal(searches(), 1);
    const refreshed = await instance.search('Series 1', { refresh: true }, system());
    assert.equal(refreshed[0].cached, undefined);
    assert.equal(searches(), 2);
    const before = axios.calls.length;
    assert.deepEqual(await instance.search('   ', undefined, system()), []);
    assert.equal(axios.calls.length, before);
});

test('lookup: full detail from one authenticated read; a manga MangaDex does not have is not_found', async () => {
    const { instance, axios } = await plugin();
    const detail = await instance.lookup(ID2, system());
    assert.equal(detail.pluginEntryId, ID2);
    assert.equal(detail.canonicalUrl, `https://mangadex.org/title/${ID2}`);
    assert.deepEqual(detail.authors, [{ name: 'Author 2', type: 'Author' }]);
    const reads = callsTo(axios.calls, `${BASE}/manga/${ID2}`);
    assert.equal(reads.length, 1);
    assert.match(reads[0].headers.Authorization, /^Bearer /);
    await assert.rejects(instance.lookup(MISSING, system()), coded('not_found'));
});

test('enrich: one contribution per id; a manga not found is that entry\'s not_found, never the batch\'s', async () => {
    const { instance } = await plugin();
    const out = await instance.enrich([ID1, MISSING], system());
    assert.equal(out[0].success, true);
    assert.equal(out[0].contribution.pluginEntryId, ID1);
    assert.deepEqual([out[1].pluginEntryId, out[1].success, out[1].error.code], [MISSING, false, 'not_found']);
});

// ── covers ───────────────────────────────────────────────────────────────────

test('searchCovers: id mode lists the manga\'s covers without a search; covers come by volume, keyed mangaId/fileName', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.searchCovers({ title: 'ignored' }, { pluginEntryId: ID2 }, system());
    assert.equal(axios.calls.some((c) => c.params && c.params.title !== undefined), false);
    assert.deepEqual(out.map((/** @type {any} */ c) => c.coverId), [`${ID2}/vol1-2.jpg`, `${ID2}/vol2-2.jpg`, `${ID2}/extra-2.jpg`]);
    assert.deepEqual({ width: out[1].width, height: out[1].height }, { width: 1000, height: 1500 });
    const cover = axios.calls.find((c) => c.url === `${BASE}/cover`);
    assert.deepEqual(cover && cover.params, { 'manga[]': ID2, limit: 100 });
});

test('searchCovers: title mode tries the alternate titles after a weak primary and takes the exact alias match', async () => {
    /** @type {string[]} */
    const asked = [];
    const { instance } = await plugin((config) => {
        if (config.url === `${BASE}/manga` && config.params && config.params.title !== undefined) {
            asked.push(config.params.title);
            if (config.params.title === 'Bad Primary Title') return { status: 200, data: { result: 'ok', data: [{ ...manga(5), attributes: { ...manga(5).attributes, title: { en: 'Bad Primary Title Side Story' }, altTitles: [] } }] } };
            if (config.params.title === 'Series 3') return { status: 200, data: { result: 'ok', data: [manga(3)] } };
        }
        return undefined;
    });
    const out = await instance.searchCovers({ title: 'Bad Primary Title', altTitles: ['Series 3'] }, undefined, system());
    assert.deepEqual(asked, ['Bad Primary Title', 'Series 3']);
    assert.ok(out.length > 0 && out.every((/** @type {any} */ c) => c.coverId.startsWith(`${mangaId(3)}/`)));
});

test('searchCovers: no title match answers no covers', async () => {
    const { instance } = await plugin();
    assert.deepEqual(await instance.searchCovers({ title: 'Nothing Like It' }, undefined, system()), []);
});

test('downloadCover: bytes from the uploads host, the second time from the cache; a malformed id is not_found; empty bytes are an error', async () => {
    const { instance, axios } = await plugin();
    const bytes = await instance.downloadCover(`${ID1}/vol1-1.jpg`, system());
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0);
    assert.ok(Buffer.isBuffer(await instance.downloadCover(`${ID1}/vol1-1.jpg`, system())));
    assert.equal(axios.calls.filter((c) => c.url === `https://uploads.mangadex.org/covers/${ID1}/vol1-1.jpg`).length, 1);
    await assert.rejects(instance.downloadCover('no-slash', system()), coded('not_found'));
    const empty = await plugin((config) => (String(config.url).startsWith('https://uploads.mangadex.org/') ? { status: 200, data: new Uint8Array(0) } : undefined));
    await assert.rejects(empty.instance.downloadCover(`${ID1}/vol1-1.jpg`, system()), coded('source_error'));
});

// ── Syncing ──────────────────────────────────────────────────────────────────

test('pullProgress: MangaDex\'s own status token and the user\'s rating, never chapter progress', async () => {
    const { instance, axios } = await plugin();
    assert.deepEqual(await instance.pullProgress(ID1, user()), { pluginEntryId: ID1, status: 'reading', chapter: null, rating: 1, lastUpdated: null });
    assert.deepEqual(await instance.pullProgress(mangaId(2), user()), { pluginEntryId: mangaId(2), status: 'on_hold', chapter: null, rating: null, lastUpdated: null });
    assert.ok(axios.calls.some((c) => c.url === `${BASE}/rating` && Array.isArray(c.params['manga[]'])));
});

test('pullProgress: a manga with no status (404) is all-null, never a throw; a failing rating read leaves the rating null', async () => {
    const { instance } = await plugin();
    assert.deepEqual(await instance.pullProgress(MISSING, user()), { pluginEntryId: MISSING, status: null, chapter: null, rating: null, lastUpdated: null });
    const noRating = await plugin((config) => (config.url === `${BASE}/rating` ? { status: 500, data: {} } : undefined));
    assert.deepEqual(await noRating.instance.pullProgress(ID1, user()), { pluginEntryId: ID1, status: 'reading', chapter: null, rating: null, lastUpdated: null });
});

test('pushProgress: the rating is POSTed to /rating/{id} rounded to MangaDex\'s integer 1–10, and what landed is reported', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.pushProgress([{ pluginEntryId: ID1, rating: 8.5 }], user());
    const post = axios.calls.find((c) => c.url === `${BASE}/rating/${ID1}`);
    assert.equal(post && post.method, 'post');
    assert.deepEqual(post && post.data, { rating: 9 });
    assert.deepEqual(out, [{ pluginEntryId: ID1, success: true, applied: { rating: 9 } }]);
});

test('pushProgress: the host\'s 0 ("cleared") is a DELETE of the rating, never a rating of 0 (MangaDex has no 0)', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.pushProgress([{ pluginEntryId: ID1, rating: 0 }], user());
    assert.equal(axios.calls.filter((c) => c.url === `${BASE}/rating/${ID1}`).map((c) => c.method).join(), 'delete');
    assert.deepEqual(out[0].applied, { rating: 0 });
});

test('pushProgress: an out-of-range rating fails its entry without a call; one entry failing never blocks the rest', async () => {
    const { instance, axios } = await plugin((config) => (config.url === `${BASE}/rating/${ID2}` ? { status: 500, data: {} } : undefined));
    const out = await instance.pushProgress([{ pluginEntryId: ID1, rating: 11 }, { pluginEntryId: ID2, rating: 5 }, { pluginEntryId: mangaId(3), rating: 7 }], user());
    assert.deepEqual(out.map((/** @type {any} */ r) => r.success), [false, false, true]);
    assert.equal(axios.calls.some((c) => c.url === `${BASE}/rating/${ID1}`), false);
});

test('pushProgress: chapter is not an axis MangaDex declares — the facade refuses it as a host defect', async () => {
    const { instance } = await plugin();
    await assert.rejects(instance.pushProgress([{ pluginEntryId: ID1, chapter: 3 }], user()), coded('host_contract_violation'));
});

test('getReadingList: one status call, then titles and ratings 100 ids at a time, every content rating asked; MangaDex\'s tokens pass through', async () => {
    const { instance, axios } = await plugin();
    const list = await instance.getReadingList(user());
    assert.equal(list.length, LIBRARY_SIZE);
    assert.equal(callsTo(axios.calls, `${BASE}/manga/status`).length, 1, 'no pagination: one call for the whole status map');
    const titleCalls = axios.calls.filter((c) => c.url === `${BASE}/manga` && c.params && c.params['ids[]']);
    assert.deepEqual(titleCalls.map((c) => [c.params['ids[]'].length, c.params.limit]), [[100, 100], [5, 5]]);
    assert.deepEqual(titleCalls[0].params['contentRating[]'], ['safe', 'suggestive', 'erotica', 'pornographic']);
    assert.deepEqual(axios.calls.filter((c) => c.url === `${BASE}/rating`).map((c) => c.params['manga[]'].length), [100, 5]);
    assert.deepEqual(list.slice(0, 6).map((/** @type {any} */ e) => e.status), ['reading', 'on_hold', 'plan_to_read', 'dropped', 're_reading', 'completed']);
    assert.equal(list[0].title, 'Series 1');
    assert.equal(list[0].rating, 1);
    assert.equal(list[1].rating, null, 'an unrated manga has no rating, never a default');
});

test('getReadingList: an account that follows nothing skips the title and rating lookups', async () => {
    const { instance, axios } = await plugin((config) => (config.url === `${BASE}/manga/status` ? { status: 200, data: { result: 'ok', statuses: {} } } : undefined));
    assert.deepEqual(await instance.getReadingList(user()), []);
    assert.equal(axios.calls.some((c) => c.url === `${BASE}/manga` || c.url === `${BASE}/rating`), false);
});

// ── Subscribing ──────────────────────────────────────────────────────────────

test('subscribe: follow, then POST the status token as the host resolved it (A6)', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.subscribe([{ pluginEntryId: ID1, status: 're_reading' }], user());
    const writes = axios.calls.filter((c) => c.method === 'post' && String(c.url).startsWith(`${BASE}/manga/${ID1}/`));
    assert.deepEqual(writes.map((c) => [c.url.slice(BASE.length), c.data]), [[`/manga/${ID1}/follow`, {}], [`/manga/${ID1}/status`, { status: 're_reading' }]]);
    assert.deepEqual(out, [{ pluginEntryId: ID1, success: true, listId: null, status: 're_reading' }]);
});

test('subscribe: no status still follows, and posts no status', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.subscribe([{ pluginEntryId: ID1, status: null }], user());
    assert.equal(axios.calls.some((c) => c.url === `${BASE}/manga/${ID1}/status`), false);
    assert.deepEqual(out[0], { pluginEntryId: ID1, success: true, listId: null, status: null });
});

test('subscribe: entries succeed or fail on their own; a refused sign-in reads as credential_rejected', async () => {
    const { instance } = await plugin();
    const out = await instance.subscribe([{ pluginEntryId: MISSING, status: 'reading' }, { pluginEntryId: ID2, status: 'dropped' }], user());
    assert.equal(out[0].success, false);
    assert.equal(out[0].error.code, 'not_found');
    assert.equal(out[1].success, true);
    const refused = await instance.subscribe([{ pluginEntryId: ID1, status: 'reading' }], user({ credential: { ...ACCOUNTS.alpha, password: 'wrong' }, identity: 'slot-wrong' }));
    assert.equal(refused[0].error.code, 'credential_rejected');
    assert.match(refused[0].error.message, /refused the sign-in/);
});

test('unsubscribe: DELETE the follow; already absent (404) is success; entries are independent', async () => {
    const { instance, axios } = await plugin((config) => (config.method === 'delete' && config.url === `${BASE}/manga/${ID2}/follow` ? { status: 500, data: {} } : undefined));
    const out = await instance.unsubscribe([ID1, MISSING, ID2], user());
    assert.deepEqual(out.map((/** @type {any} */ r) => r.success), [true, true, false]);
    assert.ok(axios.calls.some((c) => c.method === 'delete' && c.url === `${BASE}/manga/${ID1}/follow`));
});

// ── Watching ─────────────────────────────────────────────────────────────────

test('queryLive: always asks MangaDex (never the cache); a manga not found is the not_found arm', async () => {
    const { instance, axios } = await plugin();
    await instance.lookup(ID1, system());
    const before = callsTo(axios.calls, `${BASE}/manga/${ID1}`).length;
    const live = await instance.queryLive(ID1, system());
    assert.equal(live.status, 'ok');
    assert.equal(callsTo(axios.calls, `${BASE}/manga/${ID1}`).length, before + 1);
    assert.deepEqual(await instance.queryLive(MISSING, system()), { status: 'not_found' });
});

test('summarizeEntries: one batched call for the whole set, answers in the host\'s order, an unknown id not_found, never the user\'s list (Decision 3)', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.summarizeEntries([mangaId(3), MISSING, ID1], system());
    assert.deepEqual(out.map((/** @type {any} */ r) => [r.pluginEntryId, r.success]), [[mangaId(3), true], [MISSING, false], [ID1, true]]);
    assert.deepEqual(out[0].summary, { label: 'Completed', status: 'completed', latestChapter: 43, lastUpdated: '2026-10-01T00:00:00+00:00' });
    assert.equal(out[1].error.code, 'not_found');
    const batch = axios.calls.filter((c) => c.url === `${BASE}/manga` && c.params && c.params['ids[]']);
    assert.equal(batch.length, 1);
    assert.equal(axios.calls.some((c) => c.url === `${BASE}/manga/status`), false);
});

test('summarizeEntries: a failing source fails every entry, never the batch', async () => {
    const { instance } = await plugin((config) => (config.url === `${BASE}/manga` ? { status: 503, data: {} } : undefined));
    const out = await instance.summarizeEntries([ID1, ID2], system());
    assert.deepEqual(out.map((/** @type {any} */ r) => [r.pluginEntryId, r.success, r.error.code]), [[ID1, false, 'source_error'], [ID2, false, 'source_error']]);
});

// ── Retrieving (anonymous: retrieveOptions.requiresCredential false) ─────────

test('listChapters: anonymous — no sign-in, no Authorization; external chapters left out; the manga\'s languages', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.listChapters(ID1, undefined, anonymous());
    assert.deepEqual(out.chapters, [
        { id: chapterId(11), label: 'Vol. 1 Ch. 1 - Start', ordering: 0, language: 'en' },
        { id: chapterId(12), label: 'Ch. 2', ordering: 1, language: 'en' },
    ]);
    assert.deepEqual(out.availableLanguages, ['en', 'ja']);
    assert.ok(axios.calls.every((c) => !c.headers || !c.headers.Authorization));
    assert.equal(axios.calls.some((c) => c.url === `${AUTH}/token`), false);
    const feed = axios.calls.find((c) => c.url === `${BASE}/manga/${ID1}/feed`);
    assert.deepEqual(feed && feed.params, { 'translatedLanguage[]': ['en'], limit: 500, offset: 0, 'order[chapter]': 'asc', includeFutureUpdates: '0' });
});

test('listChapters: the requested language filters both the request and the answer', async () => {
    const { instance } = await plugin();
    const out = await instance.listChapters(ID1, { language: 'ja' }, anonymous());
    assert.deepEqual(out.chapters.map((/** @type {any} */ c) => [c.id, c.language, c.label]), [[chapterId(13), 'ja', 'Vol. 1 Ch. 1 - Hajimari']]);
});

test('listChapters: pages past MangaDex\'s 500-chapter limit with offset', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: `ch-${i}`, attributes: { chapter: String(i), translatedLanguage: 'en', externalUrl: null } }));
    const { instance, axios } = await plugin((config) => (config.url === `${BASE}/manga/${ID1}/feed`
        ? { status: 200, data: { result: 'ok', data: rows.slice(config.params.offset, config.params.offset + config.params.limit), total: rows.length } } : undefined));
    const out = await instance.listChapters(ID1, undefined, anonymous());
    assert.equal(out.chapters.length, 501);
    assert.equal(out.chapters[500].id, 'ch-500');
    assert.deepEqual(axios.calls.filter((c) => c.url === `${BASE}/manga/${ID1}/feed`).map((c) => c.params.offset), [0, 500]);
});

test('listChapters: the languages read failing leaves them empty, never fails the list; a cached manga is not read again', async () => {
    const failing = await plugin((config) => (config.url === `${BASE}/manga/${ID1}` ? { status: 500, data: {} } : undefined));
    const out = await failing.instance.listChapters(ID1, undefined, anonymous());
    assert.equal(out.chapters.length, 2);
    assert.deepEqual(out.availableLanguages, []);
    const { instance, axios } = await plugin();
    await instance.lookup(ID1, user());
    const reads = callsTo(axios.calls, `${BASE}/manga/${ID1}`).length;
    await instance.listChapters(ID1, undefined, anonymous());
    assert.equal(callsTo(axios.calls, `${BASE}/manga/${ID1}`).length, reads, 'the scope\'s cached manga answers the languages');
});

test('listPages: the at-home server\'s full-quality data[], numbered in reading order, anonymously', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.listPages(ID1, chapterId(11), anonymous());
    assert.deepEqual(out, [{ pageKey: '1-page.png', pageNumber: 0 }, { pageKey: '2-page.png', pageNumber: 1 }, { pageKey: '3-page.png', pageNumber: 2 }]);
    assert.ok(axios.calls.every((c) => !c.headers || !c.headers.Authorization));
});

test('listPages: an at-home answer without baseUrl/hash is a source_error', async () => {
    const { instance } = await plugin((config) => (String(config.url).includes('/at-home/server/') ? { status: 200, data: { result: 'ok', chapter: { data: [] } } } : undefined));
    await assert.rejects(instance.listPages(ID1, chapterId(11), anonymous()), coded('source_error'));
});

test('downloadPage: {baseUrl}/data/{hash}/{pageKey}, the at-home server re-resolved on every call; empty bytes are an error', async () => {
    const { instance, axios } = await plugin();
    const bytes = await instance.downloadPage(ID1, chapterId(11), '1-page.png', anonymous());
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0);
    await instance.downloadPage(ID1, chapterId(11), '2-page.png', anonymous());
    assert.equal(axios.calls.filter((c) => String(c.url).includes('/at-home/server/')).length, 2);
    assert.ok(axios.calls.some((c) => c.url === `${AT_HOME}/data/hash-${chapterId(11)}/1-page.png` && c.responseType === 'arraybuffer'));
    const empty = await plugin((config) => (String(config.url).startsWith(`${AT_HOME}/data/`) ? { status: 200, data: new Uint8Array(0) } : undefined));
    await assert.rejects(empty.instance.downloadPage(ID1, chapterId(11), '1-page.png', anonymous()), coded('source_error'));
});

// ── the edge ─────────────────────────────────────────────────────────────────

test('an HTML answer from MangaDex\'s edge is a typed error naming the page, not parsed; JSON and bytes pass', () => {
    assert.throws(
        () => htmlNormalizer({ status: 503, headers: { 'content-type': 'text/html; charset=utf-8' }, data: '<!DOCTYPE html><html><head><title>Service Unavailable</title></head></html>' }),
        (e) => isPluginError(e) && e.code === 'offline' && /MangaDex backend infrastructure error: Service Unavailable/.test(e.message),
    );
    assert.throws(() => htmlNormalizer({ status: 502, headers: {}, data: '<html><body><h1>Bad gateway</h1></body></html>' }), (e) => isPluginError(e) && /Bad gateway/.test(e.message));
    assert.doesNotThrow(() => htmlNormalizer({ status: 404, headers: { 'content-type': 'application/json' }, data: { result: 'error' } }));
    assert.doesNotThrow(() => htmlNormalizer({ status: 200, headers: { 'content-type': 'image/png' }, data: new Uint8Array([1]) }));
});

test('an HTML page from the edge reaches the caller as that typed error', async () => {
    const { instance } = await plugin((config) => (config.url === `${BASE}/manga/status` ? { status: 503, headers: { 'content-type': 'text/html' }, data: '<html><title>Just a moment...</title></html>' } : undefined));
    await assert.rejects(instance.getReadingList(user()), (e) => isPluginError(e) && e.code === 'offline' && /Just a moment/.test(e.message));
});

test('a missing endpoint template fails fast as a source_error, with no call', async () => {
    const { instance, axios } = await plugin(undefined, { 'api.endpoints.statusList.template': '' });
    await assert.rejects(instance.getReadingList(user()), (e) => isPluginError(e) && e.code === 'source_error' && /statusList/.test(e.message));
    assert.equal(axios.calls.filter((c) => String(c.url).startsWith(BASE)).length, 0);
});

test('pushProgress: a status field rides along unread — status is Subscribing\'s, never posted by a push', async () => {
    const { instance, axios } = await plugin();
    await instance.pushProgress([{ pluginEntryId: ID1, rating: 7, status: 'reading' }], user());
    assert.equal(axios.calls.some((c) => String(c.url).endsWith('/status')), false);
    const none = await instance.pushProgress([{ pluginEntryId: ID1 }], user());
    assert.deepEqual(none, [{ pluginEntryId: ID1, success: true, applied: {} }], 'nothing asked, nothing sent');
});

test('summarizeEntries: an empty request is an empty answer, with no call', async () => {
    const { instance, axios } = await plugin();
    assert.deepEqual(await instance.summarizeEntries([], system()), []);
    assert.equal(axios.calls.length, 0);
});

test('layering: the client (L4) never requires the mapping (L3b) — it exposes source calls only', () => {
    const source = fs.readFileSync(path.join(tracker.dir, `client-${tracker.id}.cjs`), 'utf8');
    assert.equal(/require\(\s*['"`]\.\/mapping-/.test(source), false, 'client-mangadex.cjs requires ./mapping-');
    assert.equal(source.includes("'./mapping-"), false, 'client-mangadex.cjs names ./mapping-');
});
