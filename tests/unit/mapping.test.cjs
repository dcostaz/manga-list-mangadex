'use strict';

/**
 * MangaDex's mapping: pure, MangaDex's shapes in, the contract's DTOs out. Ported from the 3.x mapper, search-cover,
 * readinglist, querylive, summarizeentries and retrieve tests. Changed on purpose: the status token is MangaDex's
 * own and the host resolves it (A6), where the 3.x wrapper sent the host's enum; confidence is 0–1 (was 0–100); a
 * manga MangaDex does not know is `not_found` in a summary (was `linkState: 'error'`, A4).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { validateResult } = require('@manga-list/plugin-sdk');
const { locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');
const { manga, mangaId, chapters, TOKENS } = require('../fixtures/mangadex-source.cjs');

const tracker = locateTracker();
const mapping = require(path.join(tracker.dir, `mapping-${tracker.id}.cjs`));

/** @type {import('../../src/runtime/apiwrappers/reg-mangadex/mapping-mangadex.cjs').SearchPolicy} */
const POLICY = { fuzzyThreshold: 0.6, containmentScore: 0.85, candidateLimit: 5, exactMatchPolicy: 'first' };
/** @param {string} id @param {string} title @param {Array<Record<string, string>>} [altTitles] */
const row = (id, title, altTitles = []) => ({ id, type: 'manga', attributes: { title: { en: title }, altTitles } });

test('search: candidates carry pluginEntryId, a 0–1 confidence, the canonical URL and the cover thumbnail', () => {
    const out = mapping.search({ query: 'Series 5', rows: [manga(5)], cached: false, fetchedAt: null, policy: POLICY });
    assert.deepEqual(validateResult('search', out), []);
    assert.equal(out[0].pluginEntryId, mangaId(5));
    assert.equal(out[0].title, 'Series 5');
    assert.equal(out[0].confidence, 1);
    assert.equal(out[0].canonicalUrl, `https://mangadex.org/title/${mangaId(5)}`);
    assert.equal(out[0].coverUrl, `https://uploads.mangadex.org/covers/${mangaId(5)}/cover-5.jpg.256.jpg`);
    assert.deepEqual(out[0].altTitles, ['シリーズ 5', 'Shiriizu 5']);
});

test('search: an exact match (title or alternate) shuts out the fuzzy rows; ties keep MangaDex\'s order', () => {
    const rows = [row('fuzzy', 'Solo Leveling Side Story'), row('alias', 'Na Honjaman Level Up', [{ en: 'Solo Leveling' }]), row('exact', 'Solo Leveling')];
    const out = mapping.search({ query: 'Solo Leveling', rows, cached: false, fetchedAt: null, policy: POLICY });
    assert.deepEqual(out.map((/** @type {any} */ c) => [c.pluginEntryId, c.confidence]), [['alias', 1], ['exact', 1]]);
});

test('search: without an exact match, rows at or above the fuzzy threshold, best first; containment scores the setting', () => {
    const rows = [row('weak', 'Weak Hero Primary'), row('contains', 'Weak Primary Chronicles'), row('poor', 'Unrelated')];
    const out = mapping.search({ query: 'Weak Primary', rows, cached: false, fetchedAt: null, policy: POLICY });
    assert.deepEqual(out.map((/** @type {any} */ c) => [c.pluginEntryId, c.confidence]), [['contains', 0.85], ['weak', 0.67]]);
    assert.deepEqual(mapping.search({ query: 'Weak Primary', rows, cached: false, fetchedAt: null, policy: { ...POLICY, fuzzyThreshold: 0.9 } }), []);
});

test('search: the candidate limit bounds the answer; a cached answer says so, with its fetch time when it has one', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`r${i}`, 'Same Title'));
    assert.equal(mapping.search({ query: 'Same Title', rows, cached: false, fetchedAt: null, policy: { ...POLICY, candidateLimit: 3 } }).length, 3);
    const withTime = mapping.search({ query: 'Series 1', rows: [manga(1)], cached: true, fetchedAt: '2026-01-01T00:00:00Z', policy: POLICY });
    assert.equal(withTime[0].cached, true);
    assert.equal(withTime[0].fetchedAt, '2026-01-01T00:00:00Z');
    const noTime = mapping.search({ query: 'Series 1', rows: [manga(1)], cached: true, fetchedAt: null, policy: POLICY });
    assert.equal(noTime[0].cached, true);
    assert.equal(noTime[0].fetchedAt, undefined);
});

test('similarity: slugs compare punctuation- and case-blind; containment and word overlap are partial', () => {
    assert.deepEqual(mapping._similarity(['One-Punch Man!'], ['one punch man'], 0.85), { exact: true, similarity: 1 });
    assert.deepEqual(mapping._similarity(['Berserk'], ['Berserk of Gluttony'], 0.85), { exact: false, similarity: 0.85 });
    assert.equal(mapping._similarity(['a b c'], ['a b d'], 0.85).similarity, 0.5);
});

test('lookup and enrich: the contribution — roles from the relationships, genres apart from tags, the format as type, the cover thumbnail', () => {
    const detail = mapping.lookup(manga(3));
    assert.deepEqual(validateResult('lookup', detail), []);
    assert.equal(detail.canonicalUrl, `https://mangadex.org/title/${mangaId(3)}`);
    assert.equal(detail.displayTitle, 'Series 3');
    assert.deepEqual(detail.altTitles, ['シリーズ 3', 'Shiriizu 3']);
    assert.deepEqual(detail.authors, [{ name: 'Author 3', type: 'Author' }]);
    assert.deepEqual(detail.artists, [{ name: 'Artist 3', type: 'Artist' }]);
    assert.deepEqual(detail.genres, ['Action']);
    assert.deepEqual(detail.tags, ['School Life', 'Long Strip']);
    assert.equal(detail.seriesType, 'Long Strip');
    assert.equal(detail.seriesStatus, 'completed');
    assert.equal(detail.year, 2003);
    assert.equal(detail.description, 'Series 3, a manga.');
    assert.equal(detail.coverUrl, `https://uploads.mangadex.org/covers/${mangaId(3)}/cover-3.jpg.256.jpg`);
    assert.deepEqual(detail.sourceLinks, [{ siteId: 'mangadex', siteLabel: 'MangaDex', seriesUrl: `https://mangadex.org/title/${mangaId(3)}`, isPrimary: true }]);
    assert.equal(mapping.enrich(manga(3)).contribution.pluginEntryId, mangaId(3));
    assert.equal(mapping.enrich(manga(3)).contribution.canonicalUrl, undefined, 'enrich carries the contribution only');
});

test('lookup: no format tag is "Manga"; an unknown publication status is "unknown"; relationships without names add no contributors', () => {
    const bare = { id: 'bare', attributes: { title: { ja: 'タイトル' }, status: 'cancelled', tags: [] }, relationships: [{ id: 'x', type: 'author' }] };
    const detail = mapping.lookup(bare);
    assert.equal(detail.seriesType, 'Manga');
    assert.equal(detail.seriesStatus, 'unknown');
    assert.equal(detail.authors, undefined);
    assert.equal(detail.coverUrl, undefined);
    assert.equal(detail.displayTitle, 'タイトル');
});

test('getReadingList: MangaDex\'s own status token passes through — on_hold, re_reading included (A6); titles and ratings joined by id', () => {
    const statuses = { [mangaId(1)]: 'on_hold', [mangaId(2)]: 're_reading', [mangaId(3)]: 'plan_to_read' };
    const out = mapping.getReadingList({ statuses, manga: [manga(1), manga(3)], ratings: { [mangaId(3)]: 7 } });
    assert.deepEqual(validateResult('getReadingList', out, { manifest: tracker.manifest }), []);
    assert.deepEqual(out.map((/** @type {any} */ e) => [e.status, e.title, e.rating]), [['on_hold', 'Series 1', null], ['re_reading', null, null], ['plan_to_read', 'Series 3', 7]]);
    assert.deepEqual(Object.keys(out[0]).sort(), ['canonicalUrl', 'chapter', 'lastUpdated', 'listId', 'pluginEntryId', 'priority', 'rating', 'status', 'title', 'volume']);
    assert.equal(out[0].canonicalUrl, `https://mangadex.org/title/${mangaId(1)}`);
    assert.equal(out[0].chapter, null, 'MangaDex has no series-level chapter progress');
});

test('every status MangaDex returns is a key of the manifest\'s pull table, and push writes exactly those (F9: on_hold and re_reading, never paused)', () => {
    const { push, pull } = tracker.manifest.syncOptions.statusVocabulary;
    assert.deepEqual(Object.keys(pull).sort(), [...TOKENS].sort());
    assert.deepEqual(Object.values(push).sort(), [...TOKENS].sort());
    for (const [local, token] of Object.entries(push)) assert.equal(pull[/** @type {string} */ (token)], local);
    assert.deepEqual(tracker.manifest.syncOptions.progressAxes.push, [{ axis: 'rating', scale: 'integer' }], 'MangaDex ratings are integers 1–10 (A11)');
});

test('pullProgress: the token and rating; nothing is all-null', () => {
    const out = mapping.pullProgress({ status: 'dropped', rating: 6 }, 'x');
    assert.deepEqual(validateResult('pullProgress', out, { manifest: tracker.manifest }), []);
    assert.deepEqual(out, { pluginEntryId: 'x', status: 'dropped', chapter: null, rating: 6, lastUpdated: null });
    assert.deepEqual(mapping.pullProgress({ status: null, rating: null }, 'x'), { pluginEntryId: 'x', status: null, chapter: null, rating: null, lastUpdated: null });
});

test('pushProgress and subscribe: what landed, in MangaDex\'s terms', () => {
    assert.deepEqual(mapping.pushProgress({ rating: 9 }), { applied: { rating: 9 } });
    assert.deepEqual(mapping.pushProgress({}), { applied: {} });
    assert.deepEqual(mapping.subscribe({ status: 'reading' }), { listId: null, status: 'reading' });
    assert.deepEqual(mapping.subscribe({ status: null }), { listId: null, status: null });
});

test('queryLive: an ok arm with an overview and a link, no link state', () => {
    const out = mapping.queryLive(manga(1), mangaId(1));
    assert.deepEqual(validateResult('queryLive', out), []);
    assert.equal(out.data.statusLabel, 'ongoing');
    assert.deepEqual(out.data.sections[0].fields.map((/** @type {any} */ f) => f.label), ['Series status', 'Type', 'Year', 'Alt titles']);
    assert.equal(out.data.sections[1].links[0].url, `https://mangadex.org/title/${mangaId(1)}`);
});

test('summarizeEntries: the series\' volatile state per id in the host\'s order; an id the batch lacks is not_found, never a link state', () => {
    const out = mapping.summarizeEntries([manga(1), manga(3)], [mangaId(3), 'gone', mangaId(1)]);
    assert.deepEqual(validateResult('summarizeEntries', out, { inputIds: [mangaId(3), 'gone', mangaId(1)] }), []);
    assert.deepEqual(out[0].summary, { label: 'Completed', status: 'completed', latestChapter: 43, lastUpdated: '2026-10-01T00:00:00+00:00' });
    assert.deepEqual(out[2].summary, { label: 'Ongoing', status: 'ongoing', latestChapter: null, lastUpdated: '2026-10-01T00:00:00+00:00' }, 'an empty lastChapter is null, never 0');
    assert.equal(out[1].success, false);
    assert.equal(out[1].error.code, 'not_found');
});

test('chapter labels: volume, chapter and title are each optional; no chapter number is a oneshot', () => {
    assert.equal(mapping._chapterLabel({ volume: '2', chapter: '10.5', title: ' Extra ' }), 'Vol. 2 Ch. 10.5 - Extra');
    assert.equal(mapping._chapterLabel({ volume: null, chapter: '3', title: null }), 'Ch. 3');
    assert.equal(mapping._chapterLabel({ volume: null, chapter: null, title: 'The One' }), 'Oneshot - The One');
});

test('listChapters: external chapters left out, ordering the feed\'s, the languages the manga lists; none without the manga', () => {
    const out = mapping.listChapters({ rows: chapters(1), language: 'en', manga: manga(1) });
    assert.deepEqual(validateResult('listChapters', out), []);
    assert.deepEqual(out.chapters.map((/** @type {any} */ c) => [c.ordering, c.language]), [[0, 'en'], [1, 'en'], [2, 'ja']]);
    assert.deepEqual(out.availableLanguages, ['en', 'ja']);
    assert.deepEqual(mapping.listChapters({ rows: [], language: 'en', manga: null }), { chapters: [], availableLanguages: [] });
});

test('searchCovers: every cover by volume (none last), keyed mangaId/fileName with its full and 256px URLs; limit honoured', () => {
    const covers = [
        { attributes: { fileName: 'b.jpg', volume: '10' } },
        { attributes: { fileName: 'x.jpg', volume: null } },
        { attributes: { fileName: 'a.jpg', volume: '2', width: 800, height: 1200 } },
        { attributes: { fileName: '', volume: '1' } },
    ];
    const out = mapping.searchCovers({ mangaId: 'm', covers });
    assert.deepEqual(validateResult('searchCovers', out), []);
    assert.deepEqual(out.map((/** @type {any} */ c) => c.coverId), ['m/a.jpg', 'm/b.jpg', 'm/x.jpg']);
    assert.deepEqual(out[0], { coverId: 'm/a.jpg', imageUrl: 'https://uploads.mangadex.org/covers/m/a.jpg', thumbnailUrl: 'https://uploads.mangadex.org/covers/m/a.jpg.256.jpg', width: 800, height: 1200, volumeNumber: 2 });
    assert.equal(mapping.searchCovers({ mangaId: 'm', covers }, {}, { limit: 1 }).length, 1);
    assert.deepEqual(mapping.searchCovers({ mangaId: null, covers: [] }), []);
});

test('listPages: data[] in reading order, numbered from 0', () => {
    assert.deepEqual(mapping.listPages({ chapter: { data: ['p1.png', 'p2.png'] } }), [{ pageKey: 'p1.png', pageNumber: 0 }, { pageKey: 'p2.png', pageNumber: 1 }]);
});

test('pickMatch: an exact match beats a fuzzy one and stops the search under "first", not under "highestScore"', () => {
    const fuzzy = mapping.pickMatch(null, [row('f', 'Weak Hero Primary')], ['Weak Primary'], POLICY);
    assert.equal(fuzzy.best.row.id, 'f');
    assert.equal(fuzzy.done, false);
    const exact = mapping.pickMatch(fuzzy.best, [row('e', 'Weak Primary')], ['Weak Primary'], POLICY);
    assert.deepEqual([exact.best.row.id, exact.done], ['e', true]);
    assert.equal(mapping.pickMatch(fuzzy.best, [row('e', 'Weak Primary')], ['Weak Primary'], { ...POLICY, exactMatchPolicy: 'highestScore' }).done, false);
    assert.equal(mapping.pickMatch(exact.best, [row('g', 'Weak Primary Hero')], ['Weak Primary'], POLICY).best.row.id, 'e', 'a fuzzy row never displaces an exact one');
    assert.deepEqual(mapping.pickMatch(null, [], ['x'], POLICY), { best: null, done: false });
});
