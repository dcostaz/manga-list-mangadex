'use strict';

/**
 * L4 — MangaDex's client: REACH and EXCHANGE (Plan-2026Q4-tracker-plugin-standardization §1.2).
 *
 * Talks to api.mangadex.org (and its auth realm, its uploads host and its at-home servers) and returns MangaDex's own
 * shapes. Endpoints are the settings' templates; every request goes through `view.http`, bound per call by the SDK
 * to the call's credential, identity, scope and signal. One source call per contract method, named after it (the
 * template's convention): the SDK binds `mapping.<method>(await client.<method>(...))`.
 *
 * Source facts this file relies on (the 3.x wrapper's live-confirmed behaviour and MangaDex's API documentation):
 *  - Sign-in is OAuth2 against the auth realm's `/token`, form-encoded, with a personal API client: the password
 *    grant (`username`, `password`, `client_id`, `client_secret`) mints an access token (`expires_in`, 900 s) and a
 *    refresh token; the refresh grant (`refresh_token`, the same client) mints a new access token. A refused grant
 *    is HTTP 400/401. Requests carry `Authorization: Bearer <access token>`.
 *  - Search is authenticated (owner ruling 2026-07-17); so are the manga detail, cover, status, follow and rating
 *    calls as the 3.x wrapper made them. The chapter feed, the manga detail read for its languages and the at-home
 *    server are public (`security: []`): Retrieving calls them anonymously (`retrieveOptions.requiresCredential`).
 *  - `GET /manga/status` answers every followed manga's status in one call (`{ statuses: { <id>: token } }`, no
 *    pagination); `GET /manga?ids[]=` and `GET /rating?manga[]=` take at most 100 ids per call; a manga's feed pages
 *    at 500 chapters (`limit`, `offset`, `total`).
 *  - A reading-status token is one of reading, on_hold, plan_to_read, dropped, re_reading, completed; a rating is an
 *    integer 1–10, and a rating is cleared with `DELETE /rating/{id}`.
 *  - An at-home server's `baseUrl` is valid for its chapter only and for 15 minutes: it is resolved on every call.
 */

const { PluginError, isPluginError } = require('@manga-list/plugin-sdk');
// searchCovers' title mode must decide which manga a title names before its second source call; the decision is the
// mapping's pure ranking (the same one search() answers with), never a second copy here.
const { rankRows } = require('./mapping-mangadex.cjs');

const UPLOADS = 'https://uploads.mangadex.org';
/** The `includes[]` a manga read asks for: names of authors and artists, and the main cover's file name. */
const MANGA_INCLUDES = ['author', 'artist', 'cover_art'];
/** `GET /manga` filters out pornographic titles unless asked; a batched read by id asks for every rating. */
const ALL_CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];
/** MangaDex's documented maximum ids per `GET /manga?ids[]=` (and, defensively, per `GET /rating`). */
const IDS_PER_CALL = 100;
/** MangaDex's documented maximum `limit` for a manga's chapter feed. */
const FEED_PAGE = 500;
/** An access token is retired this long before MangaDex's expiry, so none expires in flight. */
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

/** @param {unknown} value @returns {string} */
const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** @param {unknown} value @returns {number} a positive number of seconds, or 0 */
const seconds = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * @param {Record<string, unknown>} settings
 * @param {string} name - the endpoint's settings name (api.endpoints.<name>.template)
 * @param {Record<string, string | number>} [params]
 */
function endpoint(settings, name, params = {}) {
    const template = settings[`api.endpoints.${name}.template`];
    if (typeof template !== 'string' || !template) {
        throw new PluginError('source_error', `MangaDex: no endpoint template for '${name}' in the settings`);
    }
    /** @type {Record<string, string>} */
    const values = { baseUrl: String(settings['api.baseUrl'] || ''), authUrl: String(settings['api.authUrl'] || '') };
    for (const [key, value] of Object.entries(params)) values[key] = encodeURIComponent(String(value));
    let url = template;
    for (const [key, value] of Object.entries(values)) url = url.split(`\${${key}}`).join(value);
    return url;
}

/** @param {Record<string, any> | null} previous @returns {{ value: string, expiresAt?: number | null } | null} */
function usableRefresh(previous) {
    const refresh = previous && previous.refresh;
    if (!refresh || typeof refresh.value !== 'string' || !refresh.value) return null;
    return typeof refresh.expiresAt === 'number' && refresh.expiresAt <= Date.now() ? null : refresh;
}

/**
 * One grant against the auth realm's token endpoint. A refused grant (400/401/403) is `credential_rejected`.
 * @param {import('@manga-list/plugin-sdk').CallHttp} http
 * @param {Record<string, unknown>} settings
 * @param {'token' | 'refreshToken'} name
 * @param {Record<string, string>} fields
 * @param {{ value: string, expiresAt?: number | null } | null} keptRefresh - kept when the answer carries no new one
 * @returns {Promise<import('@manga-list/plugin-sdk').TokenSet>}
 */
async function grant(http, settings, name, fields, keptRefresh) {
    let response;
    try {
        response = await http.post(endpoint(settings, name), new URLSearchParams(fields).toString(), {
            endpoint: name,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
    } catch (error) {
        if (isPluginError(error) && (error.status === 400 || error.status === 401 || error.status === 403)) {
            throw new PluginError('credential_rejected', `MangaDex refused the sign-in (HTTP ${error.status}) — check the MangaDex credential`, { status: error.status });
        }
        throw error;
    }
    const data = response && response.data && typeof response.data === 'object' ? response.data : null;
    if (!data || typeof data.access_token !== 'string' || !data.access_token) {
        throw new PluginError('source_error', 'MangaDex answered the sign-in with no access token');
    }
    const now = Date.now();
    const accessTtl = (seconds(data.expires_in) || seconds(settings['cache.ttl.accessToken']) || 900) * 1000;
    /** @type {import('@manga-list/plugin-sdk').TokenSet} */
    const tokens = { access: { value: data.access_token, expiresAt: now + Math.max(accessTtl - TOKEN_EXPIRY_SKEW_MS, accessTtl / 2) } };
    if (typeof data.refresh_token === 'string' && data.refresh_token) {
        const refreshTtl = (seconds(data.refresh_expires_in) || seconds(settings['cache.ttl.refreshToken']) || 2592000) * 1000;
        tokens.refresh = { value: data.refresh_token, expiresAt: now + refreshTtl };
    } else if (keptRefresh) {
        tokens.refresh = keptRefresh;
    }
    return tokens;
}

/**
 * The password and refresh grants. An expired access token is renewed with the refresh token while it lives; a
 * refused refresh, a first sign-in and a token MangaDex rejected all use the password grant.
 * @type {import('@manga-list/plugin-sdk').AuthStrategy}
 */
const auth = {
    async exchange(credential, { http, settings, previous, reason }) {
        const c = credential && typeof credential === 'object' ? credential : {};
        const username = str(c.username);
        const password = typeof c.password === 'string' ? c.password : '';
        if (!username || !password) {
            throw new PluginError('credential_rejected', 'MangaDex needs a username and a password');
        }
        const client = { client_id: str(c.client_id), client_secret: str(c.client_secret) };
        const refresh = usableRefresh(previous);
        if (refresh && reason === 'expired') {
            try {
                return { tokens: await grant(http, settings, 'refreshToken', { grant_type: 'refresh_token', refresh_token: refresh.value, ...client }, refresh) };
            } catch {
                // a refused (or failed) refresh falls back to the password grant below
            }
        }
        return { tokens: await grant(http, settings, 'token', { grant_type: 'password', username, password, ...client }, null) };
    },
    apply(tokens, config) {
        return { ...config, headers: { ...(config.headers || {}), Authorization: `Bearer ${tokens.access.value}` } };
    },
};

/**
 * @param {string} html
 * @returns {string}
 */
function htmlErrorMessage(html) {
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (title && title[1] && title[1].trim()) return title[1].trim();
    const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return body ? body.slice(0, 180) : 'HTML error response';
}

/**
 * MangaDex's edge (Cloudflare) can answer with an HTML page where JSON belongs: a typed error naming the page,
 * never a parse of HTML (the 3.x wrapper's interceptor, as a normalizer).
 * @param {any} response
 */
function htmlNormalizer(response) {
    const headers = response && response.headers ? response.headers : {};
    const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
    const data = response ? response.data : null;
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) return;
    const isHtml = contentType.includes('text/html') || (typeof data === 'string' && /^\s*<(?:!doctype|html)/i.test(data));
    if (isHtml) {
        throw new PluginError('offline', `MangaDex backend infrastructure error: ${htmlErrorMessage(typeof data === 'string' ? data : '')}`, { status: response.status });
    }
}

/** @param {unknown} data @param {string} what */
function toBuffer(data, what) {
    /** @type {Buffer | null} */
    let bytes = null;
    if (Buffer.isBuffer(data)) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else if (typeof data === 'string') bytes = Buffer.from(data, 'binary');
    if (!bytes || bytes.length === 0) throw new PluginError('source_error', `MangaDex answered no bytes for ${what}`);
    return bytes;
}

/** @param {unknown} error */
const isNotFound = (error) => isPluginError(error) && error.code === 'not_found';

/** @template T @param {T[]} list @returns {T[][]} */
function chunks(list) {
    /** @type {T[][]} */
    const out = [];
    for (let i = 0; i < list.length; i += IDS_PER_CALL) out.push(list.slice(i, i + IDS_PER_CALL));
    return out;
}

/**
 * @param {{ settings: Record<string, unknown>, utils: Record<string, any>, addNormalizer: (fn: (response: any) => void) => void }} deps
 */
function createClient({ settings, utils, addNormalizer }) {
    addNormalizer(htmlNormalizer);
    const ttl = (/** @type {string} */ key, /** @type {number} */ fallback) => Number(settings[`cache.ttl.${key}`]) || fallback;
    const num = (/** @type {string} */ key, /** @type {number} */ fallback) => {
        const n = Number(settings[key]);
        return settings[key] !== undefined && settings[key] !== null && Number.isFinite(n) ? n : fallback;
    };
    /** @type {import('./mapping-mangadex.cjs').SearchPolicy} */
    const policy = {
        fuzzyThreshold: num('search.fuzzyThreshold', 0.6),
        containmentScore: num('search.containmentScore', 0.85),
        candidateLimit: Math.max(1, Math.trunc(num('search.candidateLimit', 5))),
        exactMatchPolicy: settings['search.exactMatchPolicy'] === 'highestScore' ? 'highestScore' : 'first',
    };
    /** @param {string} q */
    const sanitize = (q) => (utils && typeof utils.sanitizeForSearch === 'function' ? utils.sanitizeForSearch(q) : q.toLowerCase());
    /** @param {string} id */
    const mangaUrl = (id) => `${endpoint(settings, 'manga')}/${encodeURIComponent(id)}`;

    /** @param {any} view */
    return (view) => {
        const http = view.http;
        const cache = view.cache;
        /** @param {Record<string, any>} config */
        const authed = (config) => http.authedRequest(config);

        /**
         * A manga with its authors, artists and main cover; from the scope's cache when asked and fresh.
         * @param {string} id @param {{ useCache: boolean, anonymous?: boolean }} how @returns {Promise<any>}
         */
        async function manga(id, how) {
            const key = `manga:${id}`;
            if (how.useCache) {
                const hit = await cache.get(key);
                if (hit) return hit;
            }
            const config = { method: 'get', url: mangaUrl(id), params: { 'includes[]': MANGA_INCLUDES }, endpoint: 'manga' };
            const body = (await (how.anonymous ? http.request(config) : authed(config))).data;
            const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : null;
            if (!data) throw new PluginError('not_found', `MangaDex has no manga ${id}`);
            await cache.set(key, data, ttl('seriesMetadata', 86400));
            return data;
        }

        /** One title search, from the scope's cache unless refreshing. @param {string} title @param {boolean} useCache */
        async function searchRows(title, useCache) {
            const key = `search:${sanitize(title)}`;
            if (useCache) {
                const hit = /** @type {any} */ (await cache.get(key));
                if (hit && Array.isArray(hit.rows) && hit.rows.length) return { rows: hit.rows, cached: true, fetchedAt: typeof hit.fetchedAt === 'string' ? hit.fetchedAt : null };
            }
            const body = (await authed({ method: 'get', url: endpoint(settings, 'manga'), params: { title, 'includes[]': MANGA_INCLUDES }, endpoint: 'manga', timeoutKind: 'search' })).data;
            const rows = body && Array.isArray(body.data) ? body.data : [];
            const fetchedAt = new Date().toISOString();
            if (rows.length) await cache.set(key, { rows, fetchedAt }, ttl('searchResults', 3600));
            return { rows, cached: false, fetchedAt };
        }

        /** Manga by id, 100 per call, every content rating. @param {string[]} ids @returns {Promise<any[]>} */
        async function mangaByIds(ids) {
            /** @type {any[]} */
            const rows = [];
            for (const chunk of chunks([...new Set(ids.filter((id) => typeof id === 'string' && id))])) {
                const body = (await authed({ method: 'get', url: endpoint(settings, 'manga'), params: { 'ids[]': chunk, limit: chunk.length, 'contentRating[]': ALL_CONTENT_RATINGS }, endpoint: 'manga' })).data;
                if (body && Array.isArray(body.data)) rows.push(...body.data);
            }
            return rows;
        }

        /** The user's own ratings, 100 ids per call; only rated manga appear. @param {string[]} ids @returns {Promise<Record<string, number>>} */
        async function ratings(ids) {
            /** @type {Record<string, number>} */
            const out = {};
            for (const chunk of chunks([...new Set(ids.filter((id) => typeof id === 'string' && id))])) {
                const body = (await authed({ method: 'get', url: endpoint(settings, 'ratingList'), params: { 'manga[]': chunk }, endpoint: 'ratingList' })).data;
                const map = body && body.ratings && typeof body.ratings === 'object' && !Array.isArray(body.ratings) ? body.ratings : {};
                for (const [id, entry] of Object.entries(map)) {
                    if (entry && typeof entry === 'object' && typeof (/** @type {any} */ (entry)).rating === 'number') out[id] = /** @type {any} */ (entry).rating;
                }
            }
            return out;
        }

        /** Every cover of a manga (volume covers included). @param {string} mangaId @returns {Promise<any[]>} */
        async function covers(mangaId) {
            const key = `covers:${mangaId}`;
            const hit = await cache.get(key);
            if (Array.isArray(hit) && hit.length) return hit;
            const body = (await authed({ method: 'get', url: endpoint(settings, 'cover'), params: { 'manga[]': mangaId, limit: 100 }, endpoint: 'cover' })).data;
            const rows = body && Array.isArray(body.data) ? body.data : [];
            if (rows.length) await cache.set(key, rows, ttl('coverUrls', 604800));
            return rows;
        }

        /** The at-home server for a chapter, resolved fresh every time (valid 15 minutes, for that chapter only). @param {string} chapterId */
        async function atHome(chapterId) {
            if (!chapterId) throw new PluginError('not_found', 'MangaDex: a chapter id is required');
            const body = (await http.get(endpoint(settings, 'atHomeServer', { id: chapterId }), { endpoint: 'atHomeServer' })).data;
            const baseUrl = body && typeof body.baseUrl === 'string' ? body.baseUrl : '';
            const chapter = body && body.chapter && typeof body.chapter === 'object' ? body.chapter : {};
            const hash = typeof chapter.hash === 'string' ? chapter.hash : '';
            if (!baseUrl || !hash) throw new PluginError('source_error', `MangaDex's at-home answer for chapter ${chapterId} has no baseUrl/hash`);
            return { baseUrl, chapter: { hash, data: Array.isArray(chapter.data) ? chapter.data.filter((/** @type {unknown} */ f) => typeof f === 'string') : [] } };
        }

        return {
            /** @param {string} query @param {{ refresh?: boolean }} [options] */
            async search(query, options = {}) {
                const q = typeof query === 'string' ? query.trim() : '';
                if (!q) return { query: q, rows: [], cached: false, fetchedAt: null, policy };
                const found = await searchRows(q, !(options && options.refresh === true));
                return { query: q, ...found, policy };
            },
            /** @param {string} id */
            lookup: (id) => manga(id, { useCache: true }),
            /** @param {string} id */
            enrich: (id) => manga(id, { useCache: true }),
            /**
             * Id mode when the host has the Reference; title mode searches the title and its alternates, stopping at
             * an exact match unless `search.exactMatchPolicy` is `highestScore`, and takes the best-ranked manga.
             * @param {{ title?: string, altTitles?: string[] }} query @param {{ pluginEntryId?: string, limit?: number }} [options]
             */
            async searchCovers(query, options = {}) {
                let mangaId = options && typeof options.pluginEntryId === 'string' ? options.pluginEntryId : '';
                if (!mangaId) {
                    const wanted = [...new Set([str(query && query.title), ...((query && Array.isArray(query.altTitles)) ? query.altTitles.map(str) : [])].filter(Boolean))];
                    /** @type {import('./mapping-mangadex.cjs').RankedRow | null} */
                    let best = null;
                    for (const title of wanted) {
                        const top = rankRows((await searchRows(title, true)).rows, wanted, policy)[0];
                        if (!top) continue;
                        if (!best || (top.matchType === 'exact' && best.matchType !== 'exact')
                            || (top.matchType === best.matchType && top.similarity > best.similarity)) best = top;
                        if (policy.exactMatchPolicy !== 'highestScore' && top.matchType === 'exact') break;
                    }
                    if (!best) return { mangaId: null, covers: [] };
                    mangaId = String(best.row.id);
                }
                return { mangaId, covers: await covers(mangaId) };
            },
            /** coverId is `mangaId/fileName` (what searchCovers answers). @param {string} coverId */
            async downloadCover(coverId) {
                const [mangaId, fileName] = typeof coverId === 'string' ? coverId.split('/') : [];
                if (!mangaId || !fileName) throw new PluginError('not_found', `MangaDex cover id '${coverId}' is not 'mangaId/fileName'`);
                const key = `cover-bytes:${mangaId}/${fileName}`;
                const hit = await cache.get(key);
                if (typeof hit === 'string' && hit) return Buffer.from(hit, 'base64');
                const url = `${UPLOADS}/covers/${encodeURIComponent(mangaId)}/${encodeURIComponent(fileName)}`;
                const bytes = toBuffer((await http.get(url, { responseType: 'arraybuffer', endpoint: 'cover' })).data, `cover ${coverId}`);
                await cache.set(key, bytes.toString('base64'), ttl('coverUrls', 604800));
                return bytes;
            },
            /**
             * The manga's reading status (404 or none: not on the list) and, when it has one, the user's rating — a
             * rating read failing leaves the rating null rather than failing the pull (owner correction 2026-07-23).
             * @param {string} id
             */
            async pullProgress(id) {
                /** @type {string | null} */
                let status = null;
                try {
                    const body = (await authed({ method: 'get', url: endpoint(settings, 'status', { id }), endpoint: 'status' })).data;
                    status = body && typeof body.status === 'string' && body.status ? body.status : null;
                } catch (error) {
                    if (!isNotFound(error)) throw error;
                }
                if (!status) return { status: null, rating: null };
                let rating = null;
                try {
                    const map = await ratings([id]);
                    rating = typeof map[id] === 'number' ? map[id] : null;
                } catch {
                    // the rating is supplementary: the status is the pull's answer
                }
                return { status, rating };
            },
            /**
             * MangaDex holds a rating, never chapter progress. The host's 0 means "cleared": MangaDex has no 0, so it is
             * a DELETE; any other value is rounded to MangaDex's integer 1–10.
             * @param {{ pluginEntryId: string, rating?: number }} entry
             */
            async pushProgress(entry) {
                if (typeof entry.rating !== 'number') return {};
                const url = endpoint(settings, 'rating', { id: entry.pluginEntryId });
                if (entry.rating === 0) {
                    try {
                        await authed({ method: 'delete', url, endpoint: 'rating' });
                    } catch (error) {
                        if (!isNotFound(error)) throw error;
                    }
                    return { rating: 0 };
                }
                const rating = Math.round(entry.rating);
                if (!Number.isFinite(rating) || rating < 1 || rating > 10) {
                    throw new PluginError('source_error', `MangaDex ratings are integers 1–10; ${entry.rating} is not one`);
                }
                await authed({ method: 'post', url, data: { rating }, endpoint: 'rating' });
                return { rating };
            },
            /** Every followed manga's status in one call, then titles and ratings 100 ids at a time. */
            async getReadingList() {
                const body = (await authed({ method: 'get', url: endpoint(settings, 'statusList'), endpoint: 'statusList' })).data;
                const statuses = body && body.statuses && typeof body.statuses === 'object' && !Array.isArray(body.statuses) ? body.statuses : {};
                const ids = Object.keys(statuses);
                if (!ids.length) return { statuses, manga: [], ratings: {} };
                const [rows, rated] = await Promise.all([mangaByIds(ids), ratings(ids)]);
                return { statuses, manga: rows, ratings: rated };
            },
            /**
             * Follow (idempotent at MangaDex), then set the status when one is given — the token arrives resolved by
             * the host (A6). @param {{ pluginEntryId: string, status?: string | null }} entry
             */
            async subscribe(entry) {
                await authed({ method: 'post', url: endpoint(settings, 'follow', { id: entry.pluginEntryId }), data: {}, endpoint: 'follow' });
                const status = typeof entry.status === 'string' && entry.status ? entry.status : null;
                if (status) {
                    await authed({ method: 'post', url: endpoint(settings, 'status', { id: entry.pluginEntryId }), data: { status }, endpoint: 'status' });
                }
                return { status };
            },
            /** Unfollow; already absent (404) is success (§2). @param {string} id */
            async unsubscribe(id) {
                try {
                    await authed({ method: 'delete', url: endpoint(settings, 'follow', { id }), endpoint: 'follow' });
                } catch (error) {
                    if (!isNotFound(error)) throw error;
                }
                return {};
            },
            /** Always from MangaDex, never the cache: it is the entry's current state. @param {string} id */
            queryLive: (id) => manga(id, { useCache: false }),
            /** A host-named set in one call per hundred ids (the explicit binding in plugin-mangadex.cjs). @param {string[]} ids */
            summarizeEntries: (ids) => mangaByIds(ids.map(String)),
            /**
             * The whole feed for one language (default `en`), every page; the manga's languages from its (public)
             * detail, a failure there leaving them empty rather than failing the list.
             * @param {string} id @param {{ language?: string }} [options]
             */
            async listChapters(id, options = {}) {
                if (!id) throw new PluginError('not_found', 'MangaDex: a manga id is required');
                const language = options && typeof options.language === 'string' && options.language ? options.language : 'en';
                /** @type {any[]} */
                const rows = [];
                for (let offset = 0, total = Infinity; offset < total; offset += FEED_PAGE) {
                    const body = (await http.get(endpoint(settings, 'feed', { id }), {
                        params: { 'translatedLanguage[]': [language], limit: FEED_PAGE, offset, 'order[chapter]': 'asc', includeFutureUpdates: '0' },
                        endpoint: 'feed',
                    })).data;
                    const data = body && Array.isArray(body.data) ? body.data : [];
                    rows.push(...data);
                    total = body && typeof body.total === 'number' ? body.total : rows.length;
                    if (!data.length) break;
                }
                let detail = null;
                try {
                    detail = await manga(id, { useCache: true, anonymous: true });
                } catch {
                    // the languages are supplementary: the chapters are the answer
                }
                return { rows, language, manga: detail };
            },
            /** @param {string} _entryId @param {string} chapterId */
            listPages: (_entryId, chapterId) => atHome(chapterId),
            /** One page's bytes; the at-home server re-resolved for it. @param {string} _entryId @param {string} chapterId @param {string} pageKey */
            async downloadPage(_entryId, chapterId, pageKey) {
                if (!pageKey) throw new PluginError('not_found', 'MangaDex: a page key is required');
                const server = await atHome(chapterId);
                return toBuffer((await http.get(`${server.baseUrl}/data/${server.chapter.hash}/${pageKey}`, { responseType: 'arraybuffer', endpoint: 'atHomePage' })).data, `page ${pageKey}`);
            },
        };
    };
}

module.exports = { createClient, auth, endpoint, htmlNormalizer, UPLOADS, IDS_PER_CALL, FEED_PAGE };
