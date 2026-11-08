'use strict';

/**
 * The contract suite (host-capability-contract.md, through @manga-list/plugin-sdk/testing) against MangaDex,
 * with the fixture source.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runConformance } = require('@manga-list/plugin-sdk/testing');
const { locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');
const { sourceHandler, ACCOUNTS, LIBRARY_SIZE, mangaId, chapterId } = require('../fixtures/mangadex-source.cjs');

const tracker = locateTracker();
const descriptor = require(path.join(tracker.dir, `plugin-${tracker.id}.cjs`));
const values = JSON.parse(fs.readFileSync(path.join(tracker.dir, `${tracker.id}-api-settings.values.json`), 'utf8'));

/** Settings for a fast run: throttles and backoff off. */
const fastSettings = () => {
    /** @type {Record<string, unknown>} */
    const s = { ...values.settings, 'retry.backoff.initialDelay': 1, 'retry.backoff.maxDelay': 2, 'retry.maxAttempts': 2, 'rateLimit.perEndpoint.defaultDelay': 0 };
    for (const key of Object.keys(s)) if (key.endsWith('.throttle')) s[key] = 0;
    return s;
};

/** Valid ids for the fixture; the same JSON is the host check's SUITE_INPUTS. */
const INPUTS = {
    search: ['Series 1', undefined],
    lookup: [mangaId(1)],
    enrich: [[mangaId(1), mangaId(2)]],
    searchCovers: [{ title: 'Series 1' }, undefined],
    downloadCover: [`${mangaId(1)}/vol1-1.jpg`],
    pullProgress: [mangaId(1)],
    pushProgress: [[{ pluginEntryId: mangaId(1), rating: 8 }]],
    subscribe: [[{ pluginEntryId: mangaId(1), status: 'on_hold' }]],
    unsubscribe: [[mangaId(1)]],
    queryLive: [mangaId(1)],
    summarizeEntries: [[mangaId(1), mangaId(2)]],
    listChapters: [mangaId(1), undefined],
    listPages: [mangaId(1), chapterId(11)],
    downloadPage: [mangaId(1), chapterId(11), '1-page.png'],
};

test('MangaDex passes the contract suite with 0 failures', async () => {
    const report = await runConformance({
        WrapperClass: descriptor.WrapperClass,
        descriptor,
        manifest: tracker.manifest,
        settings: fastSettings(),
        source: sourceHandler,
        credentials: [ACCOUNTS.alpha, ACCOUNTS.beta],
        inputs: INPUTS,
        expect: { readingListLength: LIBRARY_SIZE },
    });
    assert.deepEqual(report.failed, []);
    for (const id of [
        'sync.list.returns-the-whole-library', 'F3.getReadingList-without-a-credential-is-rejected', 'F11.no-identity-leaks-across-calls',
        'F11.cache-keys-name-the-scope', 'result.summarizeEntries', 'result.pullProgress', 'result.listChapters', 'result.downloadPage',
        'result.testCredentials', 'status.subscribe-refuses-a-host-status', 'unsubscribe.is-idempotent',
    ]) {
        assert.ok(report.passed.includes(id), `passed ${id}`);
    }
});

module.exports = { INPUTS };
