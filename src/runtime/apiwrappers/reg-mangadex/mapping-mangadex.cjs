'use strict';

/**
 * L3b — MangaDex's mapping: MAP (Plan-2026Q4-tracker-plugin-standardization §1.2). Pure functions: MangaDex's
 * shapes in, the contract's DTOs out (host-capability-contract.md §2, §2.6). One function per contract method,
 * named after it. Reading-status tokens pass through as MangaDex's own (`reading`, `on_hold`, `re_reading`, …): the
 * host resolves them through the manifest's statusVocabulary (§2.2), never the plugin.
 *
 * MangaDex shapes this file reads (api.mangadex.org, JSON:API style):
 *  - a Manga resource `{ id, type: 'manga', attributes: { title: { <lang>: string }, altTitles: [{ <lang>: string }],
 *    description: { <lang>: string }, status, year, lastChapter, updatedAt, tags: [{ attributes: { group, name: { en } } }],
 *    availableTranslatedLanguages }, relationships: [{ id, type, attributes? }] }` — `author`, `artist` and
 *    `cover_art` relationships carry their attributes when the request asked `includes[]` for them;
 *  - a Cover resource `{ id, attributes: { fileName, volume, width?, height? } }`;
 *  - a Chapter resource `{ id, attributes: { volume, chapter, title, translatedLanguage, externalUrl } }`;
 *  - ratings `{ <mangaId>: number }` (integers 1–10, only for rated manga), the reading-status map
 *    `{ <mangaId>: token }`.
 */

const { markCached, notFoundEntry } = require('@manga-list/plugin-sdk');

const SITE = 'https://mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';

/** @param {unknown} value @returns {string} */
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** @param {string | number} id @returns {string} */
const canonicalUrl = (id) => `${SITE}/title/${id}`;

/** @param {any} manga @returns {Record<string, any>} */
const attrs = (manga) => (manga && manga.attributes && typeof manga.attributes === 'object' ? manga.attributes : {});

/** Every non-empty value of a `{ <lang>: string }` map, in order. @param {unknown} map @returns {string[]} */
function localized(map) {
    if (!map || typeof map !== 'object') return [];
    return Object.values(/** @type {Record<string, unknown>} */ (map)).map(text).filter(Boolean);
}

/** The display title: the first value of `attributes.title`. @param {any} manga @returns {string} */
function primaryTitle(manga) {
    return localized(attrs(manga).title)[0] || '';
}

/** Every other title the manga carries, the primary left out, no duplicates. @param {any} manga @returns {string[]} */
function altTitles(manga) {
    const primary = primaryTitle(manga);
    const list = Array.isArray(attrs(manga).altTitles) ? attrs(manga).altTitles : [];
    const all = list.flatMap((/** @type {unknown} */ entry) => localized(entry));
    return [...new Set(all)].filter((title) => title !== primary);
}

/** Every title of a search row, primary first, case-insensitively unique. @param {any} manga @returns {string[]} */
function candidateTitles(manga) {
    const list = Array.isArray(attrs(manga).altTitles) ? attrs(manga).altTitles : [];
    const all = [...localized(attrs(manga).title), ...list.flatMap((/** @type {unknown} */ entry) => localized(entry))];
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const title of all) {
        const key = title.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(title);
        }
    }
    return out;
}

/** @param {unknown} value @returns {string} */
function slug(value) {
    return typeof value === 'string'
        ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        : '';
}

/**
 * How well a row's titles match the wanted titles: an exact slug match is 1; one slug containing the other is the
 * containment score; else the words' overlap (Jaccard).
 * @param {string[]} wanted @param {string[]} titles @param {number} containmentScore
 * @returns {{ exact: boolean, similarity: number }}
 */
function similarity(wanted, titles, containmentScore) {
    let exact = false;
    let best = 0;
    for (const want of wanted) {
        const a = slug(want);
        if (!a) continue;
        for (const title of titles) {
            const b = slug(title);
            if (!b) continue;
            if (a === b) {
                exact = true;
                best = 1;
                continue;
            }
            let s = 0;
            if (a.includes(b) || b.includes(a)) {
                s = containmentScore;
            } else {
                const setA = new Set(a.split('-').filter(Boolean));
                const setB = new Set(b.split('-').filter(Boolean));
                const shared = [...setA].filter((w) => setB.has(w)).length;
                const union = new Set([...setA, ...setB]).size;
                s = union ? shared / union : 0;
            }
            if (s > best) best = s;
        }
    }
    return { exact, similarity: best };
}

/**
 * @typedef {{ fuzzyThreshold: number, containmentScore: number, candidateLimit: number, exactMatchPolicy: 'first' | 'highestScore' }} SearchPolicy
 * @typedef {{ row: any, matchType: 'exact' | 'fuzzy', similarity: number, index: number }} RankedRow
 */

/**
 * Rank MangaDex search rows against the wanted titles: exact matches only when there is one, else the rows at or
 * above the fuzzy threshold; best first, MangaDex's own order breaking ties; at most `candidateLimit`.
 * @param {any[]} rows @param {string[]} wanted @param {SearchPolicy} policy @returns {RankedRow[]}
 */
function rankRows(rows, wanted, policy) {
    /** @type {RankedRow[]} */
    const exact = [];
    /** @type {RankedRow[]} */
    const fuzzy = [];
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
        if (!row || typeof row.id !== 'string') return;
        const match = similarity(wanted, candidateTitles(row), policy.containmentScore);
        if (match.exact) exact.push({ row, matchType: 'exact', similarity: 1, index });
        else if (match.similarity >= policy.fuzzyThreshold) fuzzy.push({ row, matchType: 'fuzzy', similarity: match.similarity, index });
    });
    const chosen = exact.length ? exact : fuzzy;
    chosen.sort((a, b) => (b.similarity - a.similarity) || (a.index - b.index));
    return chosen.slice(0, Math.max(1, policy.candidateLimit));
}

/**
 * searchCovers' title mode, one searched title at a time: the best-ranked row of this title's rows against the best so
 * far — an exact match beats a fuzzy one, a higher similarity beats a lower one of the same kind. `done` says to stop
 * searching: an exact match under the `first` policy.
 * @param {RankedRow | null} best @param {any[]} rows @param {string[]} wanted @param {SearchPolicy} policy
 * @returns {{ best: RankedRow | null, done: boolean }}
 */
function pickMatch(best, rows, wanted, policy) {
    const top = rankRows(rows, wanted, policy)[0];
    if (!top) return { best, done: false };
    const better = !best || (top.matchType === 'exact' && best.matchType !== 'exact')
        || (top.matchType === best.matchType && top.similarity > best.similarity);
    return { best: better ? top : best, done: policy.exactMatchPolicy !== 'highestScore' && top.matchType === 'exact' };
}

/** @param {any} manga @param {string} type @returns {any[]} */
const related = (manga, type) => (manga && Array.isArray(manga.relationships)
    ? manga.relationships.filter((/** @type {any} */ r) => r && r.type === type)
    : []);

/** The main cover's file name, from the `cover_art` relationship's attributes. @param {any} manga @returns {string} */
const coverFileName = (manga) => {
    const art = related(manga, 'cover_art').find((r) => r.attributes && text(r.attributes.fileName));
    return art ? text(art.attributes.fileName) : '';
};

/** @param {any} manga @returns {string | null} the 256px thumbnail of the main cover */
function coverUrl(manga) {
    const fileName = coverFileName(manga);
    return fileName && manga && typeof manga.id === 'string' ? `${UPLOADS}/covers/${manga.id}/${fileName}.256.jpg` : null;
}

/** MangaDex's publication status → the contribution's closed set. @param {unknown} status */
function seriesStatus(status) {
    const s = typeof status === 'string' ? status.toLowerCase() : '';
    if (s === 'completed') return 'completed';
    if (s === 'hiatus') return 'hiatus';
    if (s === 'ongoing') return 'ongoing';
    return 'unknown';
}

/** @param {any} tag @returns {string} */
const tagName = (tag) => (tag && tag.attributes && tag.attributes.name ? text(tag.attributes.name.en) : '');

/**
 * Authors and artists are both `author` resources at MangaDex; the role exists only on the manga's relationship
 * (`author` | `artist`), and the name only when the request asked `includes[]` for them.
 * @param {any} manga @param {'author' | 'artist'} type @returns {Array<{ name: string, type: string }>}
 */
function contributors(manga, type) {
    const role = type === 'artist' ? 'Artist' : 'Author';
    return related(manga, type)
        .map((r) => (r.attributes ? text(r.attributes.name) : ''))
        .filter(Boolean)
        .map((name) => ({ name, type: role }));
}

/** @param {any} manga */
function contribution(manga) {
    const a = attrs(manga);
    const id = String(manga.id);
    const tags = Array.isArray(a.tags) ? a.tags : [];
    const genres = tags.filter((/** @type {any} */ t) => t && t.attributes && t.attributes.group === 'genre').map(tagName).filter(Boolean);
    const others = tags.filter((/** @type {any} */ t) => t && t.attributes && t.attributes.group !== 'genre').map(tagName).filter(Boolean);
    const formats = tags.filter((/** @type {any} */ t) => t && t.attributes && t.attributes.group === 'format').map(tagName).filter(Boolean);
    /** @type {Record<string, any>} */
    const out = { pluginEntryId: id, syncedAt: new Date().toISOString(), seriesStatus: seriesStatus(a.status) };
    const title = primaryTitle(manga);
    if (title) out.displayTitle = title;
    const alts = altTitles(manga);
    if (alts.length) out.altTitles = alts;
    const authors = contributors(manga, 'author');
    if (authors.length) out.authors = authors;
    const artists = contributors(manga, 'artist');
    if (artists.length) out.artists = artists;
    if (genres.length) out.genres = genres;
    if (others.length) out.tags = others;
    const description = a.description && typeof a.description === 'object' ? text(a.description.en) : '';
    if (description) out.description = description;
    const cover = coverUrl(manga);
    if (cover) out.coverUrl = cover;
    if (typeof a.year === 'number' && Number.isFinite(a.year)) out.year = a.year;
    out.seriesType = formats[0] || 'Manga';
    out.sourceLinks = [{ siteId: 'mangadex', siteLabel: 'MangaDex', seriesUrl: canonicalUrl(id), isPrimary: true }];
    return out;
}

/** The series' volatile state (A4): its publication status, final chapter and last change. @param {any} manga */
function cardSummary(manga) {
    const a = attrs(manga);
    const status = typeof a.status === 'string' && a.status ? a.status : null;
    const lastChapter = Number(a.lastChapter);
    return {
        label: status ? status.charAt(0).toUpperCase() + status.slice(1) : null,
        status,
        latestChapter: text(a.lastChapter) && Number.isFinite(lastChapter) ? lastChapter : null,
        lastUpdated: typeof a.updatedAt === 'string' && a.updatedAt ? a.updatedAt : null,
    };
}

/**
 * A human-readable chapter label: `Vol. <v> Ch. <c> - <title>`; a chapter with no number is a oneshot. Volume,
 * chapter and title are each independently nullable at MangaDex.
 * @param {Record<string, any>} a
 */
function chapterLabel(a) {
    const volume = text(a.volume);
    const chapter = text(a.chapter);
    const title = text(a.title);
    let label = `${volume ? `Vol. ${volume} ` : ''}${chapter ? `Ch. ${chapter}` : 'Oneshot'}`;
    if (title) label += ` - ${title}`;
    return label;
}

/** @param {unknown} volume @returns {number} */
const volumeOrder = (volume) => {
    const n = parseFloat(typeof volume === 'string' ? volume : '');
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

module.exports = {
    /**
     * @param {{ query: string, rows: any[], cached: boolean, fetchedAt: string | null, policy: SearchPolicy }} found
     */
    search(found) {
        return rankRows(found.rows, [found.query], found.policy).map(({ row, similarity: score }) => {
            const candidate = {
                pluginEntryId: String(row.id),
                title: primaryTitle(row),
                altTitles: altTitles(row),
                confidence: Math.round(score * 100) / 100,
                canonicalUrl: canonicalUrl(row.id),
                ...(coverUrl(row) ? { coverUrl: coverUrl(row) } : {}),
            };
            return found.cached ? markCached(candidate, found.fetchedAt) : candidate;
        });
    },

    /** @param {any} manga */
    lookup: (manga) => ({ ...contribution(manga), canonicalUrl: canonicalUrl(manga.id) }),

    /** @param {any} manga */
    enrich: (manga) => ({ contribution: contribution(manga) }),

    /**
     * Every cover MangaDex holds for the manga, by volume (no volume last), keyed `mangaId/fileName` — the form
     * downloadCover() takes.
     * @param {{ mangaId: string | null, covers: any[] }} found @param {unknown} _query @param {{ limit?: number }} [options]
     */
    searchCovers(found, _query, options) {
        if (!found || !found.mangaId) return [];
        const mangaId = found.mangaId;
        const out = (Array.isArray(found.covers) ? found.covers : [])
            .map((cover) => ({ a: attrs(cover) }))
            .filter(({ a }) => text(a.fileName))
            .sort((x, y) => volumeOrder(x.a.volume) - volumeOrder(y.a.volume))
            .map(({ a }) => {
                const fileName = text(a.fileName);
                const width = Number(a.width);
                const height = Number(a.height);
                const volume = parseFloat(text(a.volume));
                return {
                    coverId: `${mangaId}/${fileName}`,
                    imageUrl: `${UPLOADS}/covers/${mangaId}/${fileName}`,
                    thumbnailUrl: `${UPLOADS}/covers/${mangaId}/${fileName}.256.jpg`,
                    ...(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : {}),
                    ...(Number.isFinite(volume) ? { volumeNumber: volume } : {}),
                };
            });
        const limit = options && typeof options.limit === 'number' && options.limit > 0 ? Math.trunc(options.limit) : out.length;
        return out.slice(0, limit);
    },

    /**
     * MangaDex holds a reading status and a rating per manga; no chapter progress (no series-level chapter API).
     * @param {{ status: string | null, rating: number | null }} raw @param {string} id
     */
    pullProgress: (raw, id) => ({
        pluginEntryId: String(id),
        status: raw && typeof raw.status === 'string' && raw.status ? raw.status : null,
        chapter: null,
        rating: raw && typeof raw.rating === 'number' ? raw.rating : null,
        lastUpdated: null,
    }),

    /** What landed: the integer rating MangaDex now holds, or 0 for a rating cleared. @param {{ rating?: number }} sent */
    pushProgress: (sent) => ({ applied: typeof sent.rating === 'number' ? { rating: sent.rating } : {} }),

    /**
     * The followed list: MangaDex's own status token per manga, the title from the batched manga lookup, the user's
     * rating where they gave one. MangaDex's list carries no chapter, volume, list id, priority or change time.
     * @param {{ statuses: Record<string, string>, manga: any[], ratings: Record<string, number> }} raw
     */
    getReadingList(raw) {
        /** @type {Map<string, string>} */
        const titles = new Map();
        for (const manga of Array.isArray(raw.manga) ? raw.manga : []) {
            if (manga && typeof manga.id === 'string' && primaryTitle(manga)) titles.set(manga.id, primaryTitle(manga));
        }
        const ratings = raw.ratings || {};
        return Object.entries(raw.statuses || {})
            .filter(([id, status]) => id && typeof status === 'string' && status)
            .map(([id, status]) => ({
                pluginEntryId: id,
                title: titles.get(id) || null,
                canonicalUrl: canonicalUrl(id),
                status,
                chapter: null,
                rating: typeof ratings[id] === 'number' ? ratings[id] : null,
                volume: null,
                listId: null,
                priority: null,
                lastUpdated: null,
            }));
    },

    /** MangaDex has one list per account: no list id. @param {{ status: string | null }} out */
    subscribe: (out) => ({ listId: null, status: out && typeof out.status === 'string' ? out.status : null }),

    /** @param {any} manga @param {string} id */
    queryLive(manga, id) {
        const a = attrs(manga);
        const status = typeof a.status === 'string' && a.status ? a.status : null;
        return {
            status: 'ok',
            data: {
                pluginEntryId: String(id),
                displayTitle: primaryTitle(manga) || undefined,
                statusLabel: status || undefined,
                fetchedAt: new Date().toISOString(),
                sections: [
                    {
                        type: 'stat-grid',
                        label: 'Overview',
                        fields: [
                            { label: 'Series status', value: status || '—' },
                            { label: 'Type', value: /** @type {string} */ (contribution(manga).seriesType) },
                            { label: 'Year', value: typeof a.year === 'number' ? a.year : '—' },
                            { label: 'Alt titles', value: altTitles(manga).length },
                        ],
                    },
                    { type: 'link-list', label: 'Links', links: [{ label: 'MangaDex', url: canonicalUrl(id) }] },
                ],
            },
        };
    },

    /**
     * The batched answer for a host-named set (explicit binding in plugin-mangadex.cjs): one result per id, in the
     * host's order; an id MangaDex's batch did not return is `not_found` — a report, never a link verdict (A4).
     * @param {any[]} rows @param {string[]} ids
     */
    summarizeEntries(rows, ids) {
        /** @type {Map<string, any>} */
        const byId = new Map();
        for (const manga of Array.isArray(rows) ? rows : []) if (manga && typeof manga.id === 'string') byId.set(manga.id, manga);
        return (Array.isArray(ids) ? ids : []).map((raw) => {
            const id = String(raw);
            const manga = byId.get(id);
            return manga
                ? { pluginEntryId: id, success: true, summary: cardSummary(manga) }
                : notFoundEntry(id, `MangaDex has no manga ${id}`);
        });
    },

    /**
     * External chapters (`externalUrl` set: hosted outside MangaDex, no pages) are left out; `ordering` is the feed's
     * own order (asked `order[chapter]=asc`).
     * @param {{ rows: any[], language: string, manga: any | null }} raw
     */
    listChapters(raw) {
        const chapters = (Array.isArray(raw.rows) ? raw.rows : [])
            .filter((row) => row && row.attributes && typeof row.attributes === 'object' && row.attributes.externalUrl == null)
            .map((row, index) => ({
                id: String(row.id),
                label: chapterLabel(row.attributes),
                ordering: index,
                language: text(row.attributes.translatedLanguage) || raw.language,
            }));
        const languages = raw.manga && Array.isArray(attrs(raw.manga).availableTranslatedLanguages)
            ? attrs(raw.manga).availableTranslatedLanguages.filter((/** @type {unknown} */ l) => typeof l === 'string')
            : [];
        return { chapters, availableLanguages: languages };
    },

    /** Full quality (`data[]`), never `dataSaver[]`; the page number is the reading order. @param {{ chapter: { data: string[] } }} server */
    listPages: (server) => server.chapter.data.map((pageKey, index) => ({ pageKey, pageNumber: index })),

    // searchCovers' match decision (the explicit binding in plugin-mangadex.cjs) and the mapping tests
    rankRows,
    pickMatch,
    _similarity: similarity,
    _altTitles: altTitles,
    _chapterLabel: chapterLabel,
};
