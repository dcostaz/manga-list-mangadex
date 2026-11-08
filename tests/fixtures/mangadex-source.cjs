'use strict';

/**
 * MangaDex as a stub source, in the shapes of api.mangadex.org's documented answers and of the answers the 3.x
 * wrapper's tests recorded. An axios-shaped handler for the SDK's createStubAxios().
 *
 *  - The auth realm's `/token` takes a form-encoded body: the password grant (username, password, client_id,
 *    client_secret) and the refresh grant (refresh_token, client_id, client_secret). A wrong password is HTTP 400
 *    `invalid_grant`, an unknown client 401 `invalid_client`.
 *  - Authenticated paths need `Authorization: Bearer <a token this source minted>`; any path refuses a bearer it did
 *    not mint (401). The manga detail, the chapter feed and the at-home server are public.
 *  - The followed list has LIBRARY_SIZE entries, so titles and ratings take two `ids[]` / `manga[]` calls of at most
 *    100 ids each; more than 100 ids in one call is HTTP 400.
 */

const BASE = 'https://api.mangadex.org';
const AUTH = 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect';
const UPLOADS = 'https://uploads.mangadex.org';
const AT_HOME = 'https://node-1.mangadex.network';

const ACCOUNTS = {
    alpha: { username: 'alpha-reader', password: 'alpha-password', client_id: 'personal-client-alpha', client_secret: 'alpha-secret' },
    beta: { username: 'beta-reader', password: 'beta-password', client_id: 'personal-client-beta', client_secret: 'beta-secret' },
};
const TOKENS = ['reading', 'on_hold', 'plan_to_read', 'dropped', 're_reading', 'completed'];
const LIBRARY_SIZE = 105;
const MAX_IDS = 100;

/** @param {number} n */
const mangaId = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** @param {number} n */
const chapterId = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** @param {string} id @returns {number} */
const numberOf = (id) => (/^a0000000-0000-4000-8000-\d{12}$/.test(id) ? Number(id.slice(-12)) : NaN);
/** Known manga: 1–LIBRARY_SIZE. @param {string} id */
const known = (id) => Number.isFinite(numberOf(id)) && numberOf(id) >= 1 && numberOf(id) <= LIBRARY_SIZE;

/** @param {number} n @param {boolean} [includes] */
function manga(n, includes = true) {
    const id = mangaId(n);
    const rel = (/** @type {string} */ type, /** @type {string} */ relId, /** @type {Record<string, unknown>} */ attributes) => (includes ? { id: relId, type, attributes } : { id: relId, type });
    return {
        id,
        type: 'manga',
        attributes: {
            title: { en: `Series ${n}` },
            altTitles: [{ ja: `シリーズ ${n}` }, { 'ja-ro': `Shiriizu ${n}` }, { en: `Series ${n}` }],
            description: { en: `Series ${n}, a manga.` },
            status: n % 3 === 0 ? 'completed' : 'ongoing',
            year: 2000 + (n % 20),
            lastChapter: n % 3 === 0 ? String(40 + n) : '',
            updatedAt: '2026-10-01T00:00:00+00:00',
            availableTranslatedLanguages: ['en', 'ja'],
            tags: [
                { id: 'tag-action', type: 'tag', attributes: { name: { en: 'Action' }, group: 'genre' } },
                { id: 'tag-school', type: 'tag', attributes: { name: { en: 'School Life' }, group: 'theme' } },
                { id: 'tag-strip', type: 'tag', attributes: { name: { en: 'Long Strip' }, group: 'format' } },
            ],
        },
        relationships: [
            rel('author', `author-${n}`, { name: `Author ${n}` }),
            rel('artist', `artist-${n}`, { name: `Artist ${n}` }),
            rel('cover_art', `cover-${n}`, { fileName: `cover-${n}.jpg`, volume: '1' }),
        ],
    };
}

/** @param {number} n */
const statusOf = (n) => TOKENS[(n - 1) % TOKENS.length];
/** Every other manga is rated, 1–10. @param {number} n */
const ratingOf = (n) => (n % 2 === 1 ? ((n % 10) || 10) : null);

/** The chapters of a manga: two English, one Japanese, one external (hosted elsewhere). @param {number} n */
function chapters(n) {
    const base = n * 10;
    return [
        { id: chapterId(base + 1), type: 'chapter', attributes: { volume: '1', chapter: '1', title: 'Start', translatedLanguage: 'en', externalUrl: null } },
        { id: chapterId(base + 2), type: 'chapter', attributes: { volume: null, chapter: '2', title: null, translatedLanguage: 'en', externalUrl: null } },
        { id: chapterId(base + 3), type: 'chapter', attributes: { volume: '1', chapter: '1', title: 'Hajimari', translatedLanguage: 'ja', externalUrl: null } },
        { id: chapterId(base + 4), type: 'chapter', attributes: { volume: null, chapter: '3', title: 'Elsewhere', translatedLanguage: 'en', externalUrl: 'https://example.org/ch3' } },
    ];
}

/** Every 401 this source answers. */
const unauthorized = () => ({ status: 401, data: { result: 'error', errors: [{ status: 401, title: 'unauthorized_http_exception' }] } });
/** @param {string} detail */
const badRequest = (detail) => ({ status: 400, data: { result: 'error', errors: [{ status: 400, detail }] } });
const notFound = () => ({ status: 404, data: { result: 'error', errors: [{ status: 404, title: 'not_found_http_exception' }] } });

/** @param {unknown} value @returns {string[]} */
const asList = (value) => (Array.isArray(value) ? value.map(String) : (value === undefined || value === null ? [] : [String(value)]));

/**
 * A fresh source: its own minted tokens. `createSource()` for a test that needs its own; `sourceHandler` is one
 * shared instance for the conformance run.
 */
function createSource() {
    let minted = 0;
    /** @type {Map<string, string>} access token → username */
    const access = new Map();
    /** @type {Map<string, string>} refresh token → username */
    const refresh = new Map();
    /** @type {string[]} every grant served, in order */
    const grants = [];

    /** @param {string} username */
    function mint(username) {
        minted += 1;
        const accessToken = `access-${username}-${minted}`;
        const refreshToken = `refresh-${username}-${minted}`;
        access.set(accessToken, username);
        refresh.set(refreshToken, username);
        return { status: 200, data: { access_token: accessToken, refresh_token: refreshToken, expires_in: 900, refresh_expires_in: 2592000, token_type: 'Bearer' } };
    }

    /** @param {Record<string, any>} config */
    function handler(config) {
        const url = String(config.url || '');
        const method = String(config.method || 'get').toLowerCase();
        const params = config.params || {};
        const headers = config.headers || {};
        const bearer = typeof headers.Authorization === 'string' ? headers.Authorization.replace(/^Bearer /, '') : null;

        if (url === `${AUTH}/token`) {
            if (method !== 'post') return { status: 405, data: {} };
            const form = new URLSearchParams(typeof config.data === 'string' ? config.data : '');
            const account = Object.values(ACCOUNTS).find((a) => a.client_id === form.get('client_id') && a.client_secret === form.get('client_secret'));
            if (!account) return { status: 401, data: { error: 'invalid_client' } };
            if (form.get('grant_type') === 'password') {
                if (form.get('username') !== account.username || form.get('password') !== account.password) return { status: 400, data: { error: 'invalid_grant' } };
                grants.push('password');
                return mint(account.username);
            }
            if (form.get('grant_type') === 'refresh_token') {
                if (refresh.get(String(form.get('refresh_token'))) !== account.username) return { status: 400, data: { error: 'invalid_grant' } };
                grants.push('refresh');
                return mint(account.username);
            }
            return { status: 400, data: { error: 'unsupported_grant_type' } };
        }

        if (bearer !== null && !access.has(bearer)) return unauthorized();
        const signedIn = bearer !== null;

        if (url.startsWith(`${UPLOADS}/covers/`)) return { status: 200, data: new Uint8Array([0xff, 0xd8, 0xff, 1]), headers: { 'content-type': 'image/jpeg' } };
        if (url.startsWith(`${AT_HOME}/data/`)) return { status: 200, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), headers: { 'content-type': 'image/png' } };
        if (!url.startsWith(BASE)) return notFound();
        const path = url.slice(BASE.length);

        // public
        const atHome = path.match(/^\/at-home\/server\/([^/]+)$/);
        if (atHome) {
            return { status: 200, data: { result: 'ok', baseUrl: AT_HOME, chapter: { hash: `hash-${atHome[1]}`, data: ['1-page.png', '2-page.png', '3-page.png'], dataSaver: ['1-page.jpg', '2-page.jpg', '3-page.jpg'] } } };
        }
        const feed = path.match(/^\/manga\/([^/]+)\/feed$/);
        if (feed) {
            if (!known(feed[1])) return notFound();
            const languages = asList(params['translatedLanguage[]']);
            const rows = chapters(numberOf(feed[1])).filter((c) => !languages.length || languages.includes(c.attributes.translatedLanguage));
            const limit = Number(params.limit) || 100;
            const offset = Number(params.offset) || 0;
            return { status: 200, data: { result: 'ok', response: 'collection', data: rows.slice(offset, offset + limit), limit, offset, total: rows.length } };
        }
        const detail = path.match(/^\/manga\/([^/]+)$/);
        if (detail && detail[1] !== 'status' && method === 'get') {
            if (!known(detail[1])) return notFound();
            const includes = asList(params['includes[]']);
            return { status: 200, data: { result: 'ok', response: 'entity', data: manga(numberOf(detail[1]), includes.length > 0) } };
        }

        // authenticated
        if (!signedIn) return unauthorized();
        const user = access.get(/** @type {string} */ (bearer));

        if (path === '/manga' && method === 'get') {
            if (params['ids[]'] !== undefined) {
                const ids = asList(params['ids[]']);
                if (ids.length > MAX_IDS) return badRequest(`at most ${MAX_IDS} ids`);
                const rows = ids.filter(known).map((id) => manga(numberOf(id), asList(params['includes[]']).length > 0));
                return { status: 200, data: { result: 'ok', response: 'collection', data: rows, limit: Number(params.limit) || 10, offset: 0, total: rows.length } };
            }
            const title = String(params.title || '').toLowerCase();
            const rows = [];
            for (let n = 1; n <= LIBRARY_SIZE && rows.length < 10; n += 1) {
                if (title && `series ${n}`.includes(title)) rows.push(manga(n, asList(params['includes[]']).length > 0));
            }
            return { status: 200, data: { result: 'ok', response: 'collection', data: rows, limit: 10, offset: 0, total: rows.length } };
        }
        if (path === '/manga/status' && method === 'get') {
            /** @type {Record<string, string>} */
            const statuses = {};
            for (let n = 1; n <= LIBRARY_SIZE; n += 1) statuses[mangaId(n)] = statusOf(n);
            return { status: 200, data: { result: 'ok', statuses, user } };
        }
        const status = path.match(/^\/manga\/([^/]+)\/status$/);
        if (status) {
            if (!known(status[1])) return notFound();
            if (method === 'get') return { status: 200, data: { result: 'ok', status: statusOf(numberOf(status[1])) } };
            if (method === 'post') {
                const value = config.data && config.data.status;
                return value === null || TOKENS.includes(value) ? { status: 200, data: { result: 'ok' } } : badRequest(`status '${value}' is not one of ${TOKENS.join(', ')}`);
            }
        }
        const follow = path.match(/^\/manga\/([^/]+)\/follow$/);
        if (follow) {
            if (!known(follow[1])) return notFound();
            if (method === 'post' || method === 'delete') return { status: 200, data: { result: 'ok' } };
        }
        if (path === '/rating' && method === 'get') {
            const ids = asList(params['manga[]']);
            if (ids.length > MAX_IDS) return badRequest(`at most ${MAX_IDS} ids`);
            /** @type {Record<string, { rating: number, createdAt: string }>} */
            const ratings = {};
            for (const id of ids) {
                const r = known(id) ? ratingOf(numberOf(id)) : null;
                if (r !== null) ratings[id] = { rating: r, createdAt: '2026-01-01T00:00:00+00:00' };
            }
            return { status: 200, data: { result: 'ok', ratings } };
        }
        const rating = path.match(/^\/rating\/([^/]+)$/);
        if (rating) {
            if (!known(rating[1])) return notFound();
            if (method === 'delete') return { status: 200, data: { result: 'ok' } };
            if (method === 'post') {
                const value = config.data && config.data.rating;
                return Number.isInteger(value) && value >= 1 && value <= 10 ? { status: 200, data: { result: 'ok' } } : badRequest('rating must be an integer 1-10');
            }
        }
        if (path === '/cover' && method === 'get') {
            const id = asList(params['manga[]'])[0];
            if (!known(id)) return { status: 200, data: { result: 'ok', data: [], total: 0 } };
            const n = numberOf(id);
            const covers = [
                { id: `cover-${n}-v2`, type: 'cover_art', attributes: { fileName: `vol2-${n}.jpg`, volume: '2', locale: 'ja', width: 1000, height: 1500 } },
                { id: `cover-${n}-v1`, type: 'cover_art', attributes: { fileName: `vol1-${n}.jpg`, volume: '1', locale: 'ja' } },
                { id: `cover-${n}-x`, type: 'cover_art', attributes: { fileName: `extra-${n}.jpg`, volume: null, locale: 'ja' } },
            ];
            return { status: 200, data: { result: 'ok', response: 'collection', data: covers, total: covers.length } };
        }
        return notFound();
    }

    return { handler, grants, access, refresh };
}

const shared = createSource();

module.exports = {
    sourceHandler: shared.handler,
    createSource,
    manga,
    mangaId,
    chapterId,
    chapters,
    statusOf,
    ratingOf,
    ACCOUNTS,
    TOKENS,
    LIBRARY_SIZE,
    BASE,
    AUTH,
    UPLOADS,
    AT_HOME,
};
