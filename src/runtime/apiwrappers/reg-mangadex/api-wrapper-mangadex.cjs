'use strict';

const fs = require('fs').promises;
const path = require('path');
const MangaDexAPISettings = require(path.join(__dirname, 'api-settings-mangadex.cjs'));

const SERVICE_NAME = 'mangadex';

/** @typedef {import('../../../../types/trackertypedefs').TrackerServiceSettings} TrackerServiceSettings */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexAPIWrapperCtorParams} MangaDexAPIWrapperCtorParams */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexAPIWrapperInitOptions} MangaDexAPIWrapperInitOptions */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexRawSearchResponse} MangaDexRawSearchResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexRawEntityResponse} MangaDexRawEntityResponse */
/** @typedef {import('../../../../types/trackertypedefs').TrackerHttpClientLike} TrackerHttpClientLike */
/** @typedef {import('../../../../types/trackertypedefs').TrackerCredentials} TrackerCredentials */
/** @typedef {import('../../../../types/trackertypedefs').CredentialsRequiredCallback} CredentialsRequiredCallback */
/** @typedef {import('../../../../types/trackertypedefs').TrackerCacheAdapterLike} TrackerCacheAdapterLike */

/**
 * @param {string} value
 * @returns {string}
 */
function toSlug(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * @param {unknown} error
 * @param {string} context
 * @returns {Error}
 */
function formatError(error, context) {
  if (error instanceof Error) {
    return new Error(`(${context}) ${error.message}`);
  }

  return new Error(`(${context}) ${String(error)}`);
}

/**
 * @returns {TrackerHttpClientLike}
 */
function createFallbackHttpClient() {
  return {
    interceptors: {
      response: {
        use: () => 0,
      },
    },
    get: async () => {
      throw new Error('HTTP client is not configured for MangaDex runtime wrapper.');
    },
    post: async () => {
      throw new Error('HTTP client is not configured for MangaDex runtime wrapper.');
    },
    put: async () => {
      throw new Error('HTTP client is not configured for MangaDex runtime wrapper.');
    },
    patch: async () => {
      throw new Error('HTTP client is not configured for MangaDex runtime wrapper.');
    },
    delete: async () => {
      throw new Error('HTTP client is not configured for MangaDex runtime wrapper.');
    },
  };
}

/**
 * @returns {TrackerHttpClientLike}
 */
function createDefaultHttpClient() {
  try {
    const axiosModule = require('axios');
    const axios = axiosModule && axiosModule.default ? axiosModule.default : axiosModule;
    if (axios && typeof axios.create === 'function') {
      return axios.create();
    }
  } catch (error) {
    // Runtime wrapper supports environments that do not ship axios.
  }

  return createFallbackHttpClient();
}

/**
 * @returns {TrackerCacheAdapterLike}
 */
function createInMemoryCacheAdapter() {
  /** @type {Map<string, { value: string, expiresAt: number | null }>} */
  const cache = new Map();

  return {
    async getValue(key) {
      if (!cache.has(key)) {
        return null;
      }

      const entry = cache.get(key);
      if (!entry) {
        return null;
      }

      if (typeof entry.expiresAt === 'number' && Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
      }

      return entry.value;
    },
    async setValue(key, value, ttlSeconds) {
      const ttl = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? ttlSeconds
        : null;
      const expiresAt = ttl ? Date.now() + (ttl * 1000) : null;
      cache.set(key, { value, expiresAt });
    },
    async deleteValue(key) {
      cache.delete(key);
    },
  };
}

/**
 * @param {string[]} expectedTitles
 * @param {string[]} candidateTitles
 * @returns {{ hasExactMatch: boolean, bestSimilarity: number }}
 */
function calculateTitleSimilarity(expectedTitles, candidateTitles) {
  let hasExactMatch = false;
  let bestSimilarity = 0;

  for (const expectedTitle of expectedTitles) {
    if (typeof expectedTitle !== 'string') {
      continue;
    }

    const expectedSlug = toSlug(expectedTitle);
    if (!expectedSlug) {
      continue;
    }

    for (const candidateTitle of candidateTitles) {
      if (typeof candidateTitle !== 'string') {
        continue;
      }

      const candidateSlug = toSlug(candidateTitle);
      if (!candidateSlug) {
        continue;
      }

      if (candidateSlug === expectedSlug) {
        hasExactMatch = true;
        bestSimilarity = 1;
        continue;
      }

      let similarity = 0;
      if (candidateSlug.includes(expectedSlug) || expectedSlug.includes(candidateSlug)) {
        similarity = 0.85;
      } else {
        const expectedTokens = expectedSlug.split('-').filter(Boolean);
        const candidateTokens = candidateSlug.split('-').filter(Boolean);
        const expectedSet = new Set(expectedTokens);
        const candidateSet = new Set(candidateTokens);
        const intersection = [...expectedSet].filter((token) => candidateSet.has(token)).length;
        const union = new Set([...expectedSet, ...candidateSet]).size;
        if (union > 0) {
          similarity = intersection / union;
        }
      }

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
      }
    }
  }

  return {
    hasExactMatch,
    bestSimilarity,
  };
}

/**
 * @param {unknown} error
 * @returns {number | null}
 */
function getHttpStatus(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const response = /** @type {{ response?: { status?: number } }} */ (error).response;
  if (response && typeof response.status === 'number') {
    return response.status;
  }

  const statusCode = /** @type {{ statusCode?: number }} */ (error).statusCode;
  if (typeof statusCode === 'number') {
    return statusCode;
  }

  return null;
}

class MangaDexAPIWrapper {
  /**
  * @param {MangaDexAPIWrapperCtorParams} [params]
   * @param {MangaDexAPISettings | null} [params.apiSettings]
  * @param {TrackerServiceSettings} [params.serviceSettings]
   */
  constructor(params = {}) {
    const apiSettings = params && typeof params === 'object' ? params.apiSettings : null;
    const serviceSettings = params && typeof params === 'object' ? params.serviceSettings : null;
    const onCredentialsRequired = params && typeof params === 'object'
      ? params.onCredentialsRequired
      : null;
    const providedHttpClient = params && typeof params === 'object'
      ? params.httpClient
      : null;
    const providedCacheAdapter = params && typeof params === 'object'
      ? params.cacheAdapter
      : null;

    this.settings = serviceSettings && typeof serviceSettings === 'object' ? serviceSettings : {};
    this.apiSettings = apiSettings instanceof MangaDexAPISettings ? apiSettings : null;

    this._defaultTokenName = 'access_token';
    this.bearerToken = null;
    this.credentials = null;
    this.onCredentialsRequired = typeof onCredentialsRequired === 'function'
      ? onCredentialsRequired
      : async () => null;
    this.httpClient = providedHttpClient && typeof providedHttpClient === 'object'
      ? providedHttpClient
      : createDefaultHttpClient();
    this.cacheAdapter = providedCacheAdapter && typeof providedCacheAdapter === 'object'
      ? providedCacheAdapter
      : createInMemoryCacheAdapter();

    this._setupHttpInterceptor();
  }

  /**
   * @returns {void}
   */
  _setupHttpInterceptor() {
    const responseInterceptors = this.httpClient
      && this.httpClient.interceptors
      && this.httpClient.interceptors.response
      && typeof this.httpClient.interceptors.response.use === 'function'
      ? this.httpClient.interceptors.response
      : null;

    if (!responseInterceptors) {
      return;
    }

    responseInterceptors.use(
      (response) => response,
      (error) => {
        const response = error && typeof error === 'object' && error.response && typeof error.response === 'object'
          ? error.response
          : null;

        if (!response) {
          return Promise.reject(error);
        }

        const headers = response.headers && typeof response.headers === 'object' ? response.headers : {};
        const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
        const responseData = response.data;
        const looksLikeHtml = contentType.includes('text/html')
          || (typeof responseData === 'string' && /^\s*<(?:!doctype|html)/i.test(responseData));

        if (!looksLikeHtml) {
          return Promise.reject(error);
        }

        const cleanError = new Error('MangaDex backend infrastructure error: HTML response from upstream');
        cleanError.name = 'MangaDexBackendError';
        // @ts-ignore runtime compatibility field.
        cleanError.statusCode = typeof response.status === 'number' ? response.status : null;
        // @ts-ignore runtime compatibility field.
        cleanError.isInfrastructureError = true;
        // @ts-ignore runtime compatibility field.
        cleanError.originalError = error;

        return Promise.reject(cleanError);
      },
    );
  }

  /**
    * @param {MangaDexAPIWrapperInitOptions} [options]
   * @param {MangaDexAPISettings | null} [options.apiSettings]
    * @param {TrackerServiceSettings} [options.serviceSettings]
   * @returns {Promise<MangaDexAPIWrapper>}
   */
  static async init(options = {}) {
    const apiSettings = options && typeof options === 'object' && options.apiSettings instanceof MangaDexAPISettings
      ? options.apiSettings
      : null;

    const settingsPath = options && typeof options === 'object' && typeof options.settingsPath === 'string'
      ? options.settingsPath
      : '';

    let resolvedApiSettings = apiSettings;
    if (!resolvedApiSettings && settingsPath) {
      resolvedApiSettings = await MangaDexAPISettings.init({ settingsPath });
    }

    const explicitServiceSettings = options && typeof options === 'object' && options.serviceSettings
      && typeof options.serviceSettings === 'object'
      ? options.serviceSettings
      : null;
    const serviceSettingsFromApiSettings = resolvedApiSettings ? resolvedApiSettings.toLegacyFormat() : null;
    const serviceSettings = explicitServiceSettings || serviceSettingsFromApiSettings || {};

    const onCredentialsRequired = options && typeof options === 'object' && typeof options.onCredentialsRequired === 'function'
      ? options.onCredentialsRequired
      : async () => null;
    const directHttpClient = options && typeof options === 'object' && options.httpClient && typeof options.httpClient === 'object'
      ? options.httpClient
      : null;
    const httpClientFactory = options && typeof options === 'object' && typeof options.httpClientFactory === 'function'
      ? options.httpClientFactory
      : null;
    const httpClientFromFactory = !directHttpClient && httpClientFactory ? httpClientFactory() : null;

    const directCacheAdapter = options && typeof options === 'object' && options.cacheAdapter && typeof options.cacheAdapter === 'object'
      ? options.cacheAdapter
      : null;
    const cacheAdapterFactory = options && typeof options === 'object' && typeof options.cacheAdapterFactory === 'function'
      ? options.cacheAdapterFactory
      : null;
    const cacheAdapterFromFactory = !directCacheAdapter && cacheAdapterFactory ? cacheAdapterFactory() : null;

    return new MangaDexAPIWrapper({
      apiSettings: resolvedApiSettings,
      serviceSettings,
      onCredentialsRequired,
      httpClient: directHttpClient || httpClientFromFactory || null,
      cacheAdapter: directCacheAdapter || cacheAdapterFromFactory || null,
    });
  }

  /**
   * @returns {Promise<TrackerCredentials | null>}
   */
  async getCredentials() {
    return this.credentials && typeof this.credentials === 'object'
      ? { ...this.credentials }
      : null;
  }

  /**
   * @param {TrackerCredentials} credentials
   * @returns {Promise<TrackerCredentials>}
   */
  async setCredentials(credentials) {
    if (!credentials || typeof credentials !== 'object') {
      throw new Error('Credentials must be an object.');
    }

    this.credentials = { ...credentials };
    return { ...this.credentials };
  }

  /**
   * @param {string} dottedKey
   * @returns {unknown}
   */
  _resolveSettingValue(dottedKey) {
    if (!dottedKey) {
      return undefined;
    }

    if (this.settings && typeof this.settings === 'object' && dottedKey in this.settings) {
      return this.settings[dottedKey];
    }

    const pathSegments = dottedKey.split('.');
    let cursor = this.settings;
    for (const segment of pathSegments) {
      if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
        return undefined;
      }
      cursor = cursor[segment];
    }

    return cursor;
  }

  /**
   * @param {string} templateKey
   * @param {Record<string, string | number>} [replacements]
   * @returns {string}
   */
  _resolveEndpoint(templateKey, replacements = {}) {
    const endpointTemplate = this._resolveSettingValue(templateKey);
    if (typeof endpointTemplate !== 'string' || !endpointTemplate.trim()) {
      return '';
    }

    const baseUrl = this._resolveSettingValue('api.baseUrl');
    const authUrl = this._resolveSettingValue('api.authUrl');

    /** @type {Record<string, string>} */
    const allReplacements = {
      baseUrl: typeof baseUrl === 'string' ? baseUrl : '',
      authUrl: typeof authUrl === 'string' ? authUrl : '',
    };
    for (const [key, value] of Object.entries(replacements)) {
      allReplacements[key] = String(value);
    }

    let resolved = endpointTemplate;
    for (const [key, value] of Object.entries(allReplacements)) {
      resolved = resolved.split(`$\{${key}\}`).join(value);
    }
    return resolved;
  }

  /**
   * @param {string} [overrideTokenName]
   * @returns {string}
   */
  _getTokenCacheKey(overrideTokenName) {
    const tokenName = typeof overrideTokenName === 'string' && overrideTokenName
      ? overrideTokenName
      : this._defaultTokenName;
    return `${SERVICE_NAME}_${tokenName}`;
  }

  /**
   * @param {string} key
   * @returns {Promise<unknown | null>}
   */
  async _getJSONCacheValue(key) {
    if (!this.cacheAdapter || typeof this.cacheAdapter.getValue !== 'function') {
      return null;
    }

    const raw = await this.cacheAdapter.getValue(key);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @param {number} ttlSeconds
   * @returns {Promise<void>}
   */
  async _setJSONCacheValue(key, value, ttlSeconds) {
    if (!this.cacheAdapter || typeof this.cacheAdapter.setValue !== 'function') {
      return;
    }

    await this.cacheAdapter.setValue(key, JSON.stringify(value), ttlSeconds);
  }

  /**
   * @param {boolean} [forceRefresh]
   * @returns {Promise<string>}
   */
  async getToken(forceRefresh = false) {
    const accessKey = this._getTokenCacheKey('access_token');
    if (!forceRefresh && this.bearerToken) {
      return this.bearerToken;
    }

    if (!forceRefresh && this.cacheAdapter) {
      const cached = await this.cacheAdapter.getValue(accessKey);
      if (cached) {
        this.bearerToken = cached;
        return cached;
      }
    }

    let credentials = await this.getCredentials();
    if (!credentials && typeof this.onCredentialsRequired === 'function') {
      const provided = await this.onCredentialsRequired({
        serviceName: SERVICE_NAME,
        settings: this.settings,
      });

      if (provided && typeof provided === 'object') {
        await this.setCredentials(provided);
        credentials = provided;
      }
    }

    if (!credentials) {
      throw new Error('Credentials not found and callback did not provide credentials.');
    }

    const tokenData = await this._fetchNewToken(credentials, { forceRefresh });
    const accessToken = await this._extractToken(tokenData);
    if (!accessToken) {
      return '';
    }

    await this._cacheToken(tokenData);
    this.bearerToken = accessToken;
    return accessToken;
  }

  /**
   * @param {TrackerCredentials} credentials
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {Promise<Record<string, string>>}
   */
  async _fetchNewToken(credentials, options = {}) {
    const forceRefresh = options && typeof options === 'object' && options.forceRefresh === true;
    const refreshKey = this._getTokenCacheKey('refresh_token');
    const cachedRefreshToken = forceRefresh ? null : await this.cacheAdapter.getValue(refreshKey);
    const useRefreshFlow = Boolean(cachedRefreshToken) && !forceRefresh;

    const endpoint = this._resolveEndpoint(
      useRefreshFlow ? 'api.endpoints.refreshToken.template' : 'api.endpoints.token.template',
    );
    if (!endpoint) {
      throw new Error('(_fetchNewToken) Missing token endpoint configuration');
    }

    const params = new URLSearchParams();
    if (useRefreshFlow) {
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', cachedRefreshToken || '');
    } else {
      params.append('grant_type', 'password');
      params.append('username', credentials.username || '');
      params.append('password', credentials.password || '');
    }
    params.append('client_id', credentials.clientId || '');
    params.append('client_secret', credentials.clientSecret || '');

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(_fetchNewToken) HTTP client post method is not configured');
    }

    try {
      const response = await this.httpClient.post(endpoint, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const responseData = response && typeof response === 'object' && response.data && typeof response.data === 'object'
        ? response.data
        : null;
      if (!responseData || typeof responseData.access_token !== 'string' || !responseData.access_token) {
        throw new Error('Missing access token in MangaDex response');
      }

      return {
        access_token: responseData.access_token,
        refresh_token: typeof responseData.refresh_token === 'string' ? responseData.refresh_token : '',
      };
    } catch (error) {
      if (useRefreshFlow) {
        if (this.cacheAdapter && typeof this.cacheAdapter.deleteValue === 'function') {
          await this.cacheAdapter.deleteValue(refreshKey);
        }
        return this._fetchNewToken(credentials, { forceRefresh: true });
      }

      throw formatError(error, '_fetchNewToken');
    }
  }

  /**
   * @param {Record<string, string>} tokenData
   * @returns {Promise<string>}
   */
  async _extractToken(tokenData) {
    if (!tokenData || typeof tokenData !== 'object') {
      return '';
    }
    return typeof tokenData.access_token === 'string' ? tokenData.access_token : '';
  }

  /**
   * @param {Record<string, string>} tokenData
   * @returns {Promise<void>}
   */
  async _cacheToken(tokenData) {
    if (!tokenData || typeof tokenData !== 'object' || !this.cacheAdapter) {
      return;
    }

    if (typeof tokenData.access_token === 'string' && tokenData.access_token) {
      await this.cacheAdapter.setValue(
        this._getTokenCacheKey('access_token'),
        tokenData.access_token,
        this._getTokenTTL('access_token'),
      );
      this.bearerToken = tokenData.access_token;
    }

    if (typeof tokenData.refresh_token === 'string' && tokenData.refresh_token) {
      await this.cacheAdapter.setValue(
        this._getTokenCacheKey('refresh_token'),
        tokenData.refresh_token,
        this._getTokenTTL('refresh_token'),
      );
    }
  }

  /**
   * @param {string} tokenType
   * @returns {number}
   */
  _getTokenTTL(tokenType) {
    if (tokenType === 'access_token') {
      return 15 * 60;
    }

    if (tokenType === 'refresh_token') {
      return 30 * 24 * 60 * 60;
    }

    return 60;
  }

  /**
   * @param {string} query
  * @returns {Promise<MangaDexRawSearchResponse>}
   */
  async searchTrackersRaw(query, options = {}) {
    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    const targetTitles = this._buildTitleList(query, options);

    for (const title of targetTitles) {
      const searchResult = await this.searchManga(title, useCache);
      const rows = Array.isArray(searchResult && searchResult.data)
        ? searchResult.data
        : [];

      if (rows.length === 0) {
        continue;
      }

      const ranked = this._rankSearchRows(rows, targetTitles);
      const mapped = ranked
        .map((row) => {
          const rowData = row && typeof row === 'object' && row.row && typeof row.row === 'object'
            ? row.row
            : null;
          const rowId = rowData && typeof rowData.id === 'string' ? rowData.id : null;
          const attributes = rowData && rowData.attributes && typeof rowData.attributes === 'object'
            ? rowData.attributes
            : null;
          const titleValues = attributes && attributes.title && typeof attributes.title === 'object'
            ? Object.values(attributes.title).filter((entry) => typeof entry === 'string' && entry.trim())
            : [];

          if (!rowId || titleValues.length === 0) {
            return null;
          }

          return {
            id: rowId,
            title: String(titleValues[0]),
          };
        })
        .filter((row) => row !== null);

      if (mapped.length > 0) {
        return {
          trackerId: SERVICE_NAME,
          operation: 'searchTrackersRaw',
          payload: { data: mapped },
        };
      }
    }

    return {
      trackerId: SERVICE_NAME,
      operation: 'searchTrackersRaw',
      payload: { data: [] },
    };
  }

  /**
   * @param {Record<string, unknown> | string} searchable
   * @param {{ useCache?: boolean, searchTitles?: string[] }} [options]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async searchTrackers(searchable, options = {}) {
    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    const targetTitles = this._buildTitleList(searchable, options);

    for (const searchTitle of targetTitles) {
      const searchResult = await this.searchManga(searchTitle, useCache);
      const rows = Array.isArray(searchResult && searchResult.data)
        ? searchResult.data
        : [];
      if (rows.length === 0) {
        continue;
      }

      const ranked = this._rankSearchRows(rows, targetTitles);
      if (ranked.length === 0) {
        continue;
      }

      const normalized = await Promise.all(
        ranked.map(async (entry) => {
          const base = await this._normalizeSeriesData(entry.row, useCache);
          return {
            ...base,
            confidence: entry.matchType === 'exact' ? 100 : entry.matchType === 'fuzzy' ? 80 : 0,
            matchType: entry.matchType,
          };
        }),
      );

      if (normalized.length > 0) {
        return normalized;
      }
    }

    return [];
  }

  /**
   * @param {string} title
   * @param {boolean} [useCache]
   * @param {{ cacheHit?: boolean }} [cacheMeta]
   * @returns {Promise<{ data: Array<Record<string, unknown>>, includes: Array<Record<string, unknown>> }>}
   */
  async searchManga(title, useCache = true, cacheMeta) {
    const cacheKey = `mangadex_searchManga_${toSlug(title)}`;
    const meta = cacheMeta && typeof cacheMeta === 'object' ? cacheMeta : null;

    if (useCache) {
      const cached = await this._getJSONCacheValue(cacheKey);
      if (cached && typeof cached === 'object' && Array.isArray(cached.data) && cached.data.length > 0) {
        if (meta) {
          meta.cacheHit = true;
        }
        return {
          data: cached.data,
          includes: Array.isArray(cached.includes) ? cached.includes : [],
        };
      }
    }

    if (meta) {
      meta.cacheHit = false;
    }

    await this.getToken();

    const endpoint = this._resolveEndpoint('api.endpoints.manga.template');
    if (!endpoint) {
      throw new Error('(searchManga) Missing manga endpoint config');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(searchManga) HTTP client get method is not configured');
    }

    const response = await this.httpClient.get(endpoint, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
      params: {
        title,
        'includes[]': ['author', 'artist'],
      },
    });

    const responseData = response && typeof response === 'object' && response.data && typeof response.data === 'object'
      ? response.data
      : {};
    const result = {
      data: Array.isArray(responseData.data) ? responseData.data : [],
      includes: Array.isArray(responseData.included) ? responseData.included : [],
    };

    if (result.data.length > 0) {
      await this._setJSONCacheValue(cacheKey, result, 24 * 60 * 60);
    }

    return result;
  }

  /**
   * @param {string} mangaId
   * @param {boolean} [useCache]
   * @returns {Promise<{ data: Record<string, unknown> | null, includes: Array<Record<string, unknown>> }>}
   */
  async getMangaById(mangaId, useCache = true) {
    const cacheKey = `mangadex_getMangaById_${mangaId}`;
    if (useCache) {
      const cached = await this._getJSONCacheValue(cacheKey);
      if (cached && typeof cached === 'object' && cached.data && typeof cached.data === 'object') {
        return {
          data: cached.data,
          includes: Array.isArray(cached.includes) ? cached.includes : [],
        };
      }
    }

    await this.getToken();
    const endpoint = `${this._resolveSettingValue('api.baseUrl') || ''}/manga/${mangaId}`;
    if (!endpoint.startsWith('http')) {
      throw new Error('(getMangaById) Missing base URL config');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(getMangaById) HTTP client get method is not configured');
    }

    const response = await this.httpClient.get(endpoint, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
      params: {
        'includes[]': ['author', 'artist'],
      },
    });

    const responseData = response && typeof response === 'object' && response.data && typeof response.data === 'object'
      ? response.data
      : {};
    const result = {
      data: responseData.data && typeof responseData.data === 'object' ? responseData.data : null,
      includes: Array.isArray(responseData.included) ? responseData.included : [],
    };

    if (result.data) {
      await this._setJSONCacheValue(cacheKey, result, 24 * 60 * 60);
    }

    return result;
  }

  /**
   * @param {string} mangaId
   * @param {boolean} [useCache]
   * @param {{ cacheHit?: boolean }} [cacheMeta]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async getCovers(mangaId, useCache = true, cacheMeta) {
    const cacheKey = `mangadex_getCovers_${mangaId}`;
    const meta = cacheMeta && typeof cacheMeta === 'object' ? cacheMeta : null;

    if (useCache) {
      const cached = await this._getJSONCacheValue(cacheKey);
      if (Array.isArray(cached) && cached.length > 0) {
        if (meta) {
          meta.cacheHit = true;
        }
        return cached;
      }
    }

    if (meta) {
      meta.cacheHit = false;
    }

    await this.getToken();

    const endpoint = this._resolveEndpoint('api.endpoints.cover.template');
    if (!endpoint) {
      throw new Error('(getCovers) Missing cover endpoint config');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(getCovers) HTTP client get method is not configured');
    }

    const response = await this.httpClient.get(endpoint, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
      params: { 'manga[]': mangaId, limit: 100 },
    });

    const responseData = response && typeof response === 'object' && response.data && typeof response.data === 'object'
      ? response.data
      : {};
    const rows = Array.isArray(responseData.data) ? responseData.data : [];

    if (rows.length > 0) {
      await this._setJSONCacheValue(cacheKey, rows, 24 * 60 * 60);
    }

    return rows;
  }

  /**
   * @param {string[]} authorIds
   * @param {boolean} [useCache]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async getAuthors(authorIds, useCache = true) {
    if (!Array.isArray(authorIds) || authorIds.length === 0) {
      return [];
    }

    const limitedIds = authorIds.slice(0, 100).sort();
    const cacheKey = `mangadex_getAuthors_${limitedIds.join('_')}`;

    if (useCache) {
      const cached = await this._getJSONCacheValue(cacheKey);
      if (Array.isArray(cached)) {
        return cached;
      }
    }

    await this.getToken();

    const baseUrl = this._resolveSettingValue('api.baseUrl');
    if (typeof baseUrl !== 'string' || !baseUrl) {
      throw new Error('(getAuthors) Missing base URL config');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(getAuthors) HTTP client get method is not configured');
    }

    try {
      const response = await this.httpClient.get(`${baseUrl}/author`, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
        params: { 'ids[]': limitedIds, limit: 100 },
      });

      const responseData = response && typeof response === 'object' && response.data && typeof response.data === 'object'
        ? response.data
        : {};
      const rows = Array.isArray(responseData.data) ? responseData.data : [];

      if (rows.length > 0) {
        await this._setJSONCacheValue(cacheKey, rows, 24 * 60 * 60);
      }

      return rows;
    } catch (error) {
      return [];
    }
  }

  /**
   * @param {Record<string, unknown>} manga
   * @param {boolean} [useCache]
   * @returns {Promise<Record<string, unknown>>}
   */
  async _normalizeSeriesData(manga, useCache = true) {
    const relationships = Array.isArray(manga.relationships) ? manga.relationships : [];
    const authorIds = relationships
      .filter((rel) => rel && typeof rel === 'object' && (rel.type === 'author' || rel.type === 'artist'))
      .map((rel) => rel.id)
      .filter((id) => typeof id === 'string');

    const authorRows = authorIds.length > 0 ? await this.getAuthors(authorIds, useCache) : [];
    const authorNames = authorRows
      .map((row) => row && row.attributes && typeof row.attributes === 'object' ? row.attributes.name : null)
      .filter((name) => typeof name === 'string' && name.trim());

    const altTitles = manga && manga.attributes && typeof manga.attributes === 'object' && Array.isArray(manga.attributes.altTitles)
      ? manga.attributes.altTitles
        .flatMap((entry) => (entry && typeof entry === 'object' ? Object.values(entry) : []))
        .filter((entry) => typeof entry === 'string' && entry.trim())
      : [];

    let coverUrl = null;
    if (manga && typeof manga.id === 'string') {
      const covers = await this.getCovers(manga.id, useCache);
      if (Array.isArray(covers) && covers.length > 0) {
        const first = covers[0] && covers[0].attributes && typeof covers[0].attributes === 'object'
          ? covers[0].attributes
          : null;
        const fileName = first && typeof first.fileName === 'string' ? first.fileName : '';
        if (fileName) {
          coverUrl = `https://uploads.mangadex.org/covers/${manga.id}/${fileName}.256.jpg`;
        }
      }
    }

    const mainTitleValues = manga && manga.attributes && typeof manga.attributes === 'object' && manga.attributes.title
      && typeof manga.attributes.title === 'object'
      ? Object.values(manga.attributes.title).filter((entry) => typeof entry === 'string' && entry.trim())
      : [];

    return {
      source: SERVICE_NAME,
      trackerId: typeof manga.id === 'string' ? manga.id : null,
      title: mainTitleValues.length > 0 ? String(mainTitleValues[0]) : '',
      alternativeTitles: altTitles,
      coverUrl,
      metadata: {
        year: manga && manga.attributes && typeof manga.attributes === 'object' && typeof manga.attributes.year === 'number'
          ? manga.attributes.year
          : null,
        type: typeof manga.type === 'string' ? manga.type : 'Manga',
        description: manga && manga.attributes && typeof manga.attributes === 'object' && manga.attributes.description
          && typeof manga.attributes.description === 'object' && typeof manga.attributes.description.en === 'string'
          ? manga.attributes.description.en
          : '',
        relationships,
        authors: authorNames,
      },
      confidence: 100,
      matchType: 'exact',
    };
  }

  /**
   * @param {string|number} trackerId
   * @param {boolean} [useCache]
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async getSeriesById(trackerId, useCache = true) {
    try {
      const result = await this.getMangaById(String(trackerId), useCache);
      if (!result || !result.data || typeof result.data !== 'object') {
        return null;
      }
      return this._normalizeSeriesData(result.data, useCache);
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {string} trackerId
  * @returns {Promise<MangaDexRawEntityResponse>}
   */
  async getSeriesByIdRaw(trackerId, useCache = true) {
    const result = await this.getMangaById(String(trackerId), useCache);
    const manga = result && typeof result === 'object' && result.data && typeof result.data === 'object'
      ? result.data
      : null;

    if (!manga) {
      return {
        trackerId: SERVICE_NAME,
        operation: 'getSeriesByIdRaw',
        payload: {
          id: String(trackerId || ''),
          title: '',
        },
      };
    }

    const titleValues = manga.attributes && typeof manga.attributes === 'object' && manga.attributes.title
      && typeof manga.attributes.title === 'object'
      ? Object.values(manga.attributes.title).filter((entry) => typeof entry === 'string' && entry.trim())
      : [];

    return {
      trackerId: SERVICE_NAME,
      operation: 'getSeriesByIdRaw',
      payload: {
        id: typeof manga.id === 'string' ? manga.id : String(trackerId || ''),
        title: titleValues.length > 0 ? String(titleValues[0]) : '',
      },
    };
  }

  /**
   * @param {string} trackerId
  * @returns {Promise<MangaDexRawEntityResponse>}
   */
  async getUserProgressRaw(trackerId) {
    const status = await this.getReadingStatus(trackerId, true);
    return {
      trackerId: SERVICE_NAME,
      operation: 'getUserProgressRaw',
      payload: {
        trackerId: typeof trackerId === 'string' ? trackerId : String(trackerId || ''),
        status: status || null,
        chapter: null,
        volume: null,
        rating: null,
      },
    };
  }

  /**
   * @param {string|number} seriesId
   * @param {boolean} [useCache]
   * @returns {Promise<string | null>}
   */
  async getReadingStatus(seriesId, useCache = true) {
    if (!seriesId) {
      throw new Error('(getReadingStatus) seriesId is required');
    }

    const cacheKey = `mangadex_readingStatus_${seriesId}`;
    if (useCache && this.cacheAdapter) {
      const cached = await this.cacheAdapter.getValue(cacheKey);
      if (cached) {
        return cached;
      }
    }

    await this.getToken();

    const endpoint = this._resolveEndpoint('api.endpoints.status.template', { id: String(seriesId) });
    if (!endpoint) {
      throw new Error('(getReadingStatus) Missing status endpoint config');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(getReadingStatus) HTTP client get method is not configured');
    }

    try {
      const response = await this.httpClient.get(endpoint, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      });

      const responseData = response && typeof response === 'object' && response.data && typeof response.data === 'object'
        ? response.data
        : {};
      const status = typeof responseData.status === 'string' ? responseData.status : null;
      if (status && this.cacheAdapter) {
        await this.cacheAdapter.setValue(cacheKey, status, 60 * 60);
      }

      return status;
    } catch (error) {
      if (getHttpStatus(error) === 404) {
        return null;
      }

      throw formatError(error, 'getReadingStatus');
    }
  }

  /**
   * @param {string|number} seriesId
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async getUserProgress(seriesId) {
    const status = await this.getReadingStatus(seriesId, true);
    if (!status) {
      return null;
    }

    const statusMap = {
      reading: 'READING',
      completed: 'COMPLETED',
      plan_to_read: 'PLAN_TO_READ',
      on_hold: 'ON_HOLD',
      dropped: 'DROPPED',
      re_reading: 'RE_READING',
    };

    return {
      status: statusMap[status] || 'READING',
    };
  }

  /**
   * @param {string|number} trackerId
   * @param {string} status
   * @returns {Promise<{ status: number | null, data: unknown }>}
   */
  async updateStatus(trackerId, status) {
    await this.getToken();

    const endpoint = this._resolveEndpoint('api.endpoints.status.template', {
      id: String(trackerId),
    });
    if (!endpoint) {
      throw new Error('(updateStatus) Missing status endpoint config');
    }

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(updateStatus) HTTP client post method is not configured');
    }

    const response = await this.httpClient.post(endpoint, { status }, {
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (this.cacheAdapter) {
      await this.cacheAdapter.setValue(`mangadex_readingStatus_${trackerId}`, status, 60 * 60);
    }

    return {
      status: typeof response.status === 'number' ? response.status : null,
      data: response && typeof response === 'object' ? response.data : null,
    };
  }

  /**
   * @param {string|number} trackerId
   * @param {number} _chapter
   * @returns {Promise<{ status: number | null, data: unknown }>}
   */
  async updateChapter(trackerId, _chapter) {
    throw new Error('(MangaDex.updateChapter) Series-level chapter progress not supported by MangaDex API. Use chapter-level read markers instead.');
  }

  /**
   * @param {string|number} trackerId
   * @param {number} _rating
   * @returns {Promise<{ status: number | null, data: unknown }>}
   */
  async updateRating(trackerId, _rating) {
    throw new Error('(MangaDex.updateRating) User ratings not supported by MangaDex API.');
  }

  /**
   * @param {{ seriesId: string | number, status?: string, chapter?: number, volume?: number, rating?: number }} subscriptionData
   * @returns {Promise<void>}
   */
  async subscribeToReadingList(subscriptionData) {
    const seriesId = subscriptionData && typeof subscriptionData === 'object' ? subscriptionData.seriesId : null;
    const status = subscriptionData && typeof subscriptionData === 'object' ? subscriptionData.status : null;

    if (!seriesId) {
      throw new Error('(subscribeToReadingList) seriesId is required');
    }

    await this.getToken();

    const followEndpoint = this._resolveEndpoint('api.endpoints.follow.template', {
      id: String(seriesId),
    });
    const statusEndpoint = this._resolveEndpoint('api.endpoints.status.template', {
      id: String(seriesId),
    });
    if (!followEndpoint || !statusEndpoint) {
      throw new Error('(subscribeToReadingList) Missing follow or status endpoint config');
    }

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(subscribeToReadingList) HTTP client post method is not configured');
    }

    await this.httpClient.post(followEndpoint, {}, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    if (!status || typeof status !== 'string') {
      return;
    }

    const map = {
      READING: 'reading',
      COMPLETED: 'completed',
      PLAN_TO_READ: 'plan_to_read',
      ON_HOLD: 'on_hold',
      DROPPED: 'dropped',
      RE_READING: 're_reading',
    };

    const mappedStatus = map[status] || 'reading';
    await this.httpClient.post(statusEndpoint, { status: mappedStatus }, {
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (this.cacheAdapter) {
      await this.cacheAdapter.setValue(`mangadex_readingStatus_${seriesId}`, mappedStatus, 60 * 60);
    }
  }

  /**
   * @param {string|number} seriesId
   * @param {Record<string, unknown>} [progress]
   * @returns {Promise<Record<string, unknown>>}
   */
  async setUserProgress(seriesId, progress = {}) {
    if (!seriesId) {
      throw new Error('(setUserProgress) seriesId is required');
    }

    if (!progress || typeof progress !== 'object' || typeof progress.status !== 'string') {
      return {
        success: false,
        error: 'MangaDex only supports reading status updates during push sync.',
      };
    }

    const map = {
      READING: 'reading',
      COMPLETED: 'completed',
      PLAN_TO_READ: 'plan_to_read',
      ON_HOLD: 'on_hold',
      DROPPED: 'dropped',
      RE_READING: 're_reading',
    };

    const mappedStatus = map[progress.status];
    if (!mappedStatus) {
      return {
        success: false,
        error: `Status "${progress.status}" is not supported by MangaDex`,
      };
    }

    await this.updateStatus(seriesId, mappedStatus);
    return {
      success: true,
      updatedFields: ['status'],
      message: 'Updated status on MangaDex',
    };
  }

  /**
   * @param {string|number} seriesId
   * @returns {Promise<void>}
   */
  async unfollowManga(seriesId) {
    if (!seriesId) {
      throw new Error('(unfollowManga) seriesId is required');
    }

    await this.getToken();

    const endpoint = this._resolveEndpoint('api.endpoints.follow.template', {
      id: String(seriesId),
    });
    if (!endpoint) {
      throw new Error('(unfollowManga) Missing follow endpoint config');
    }

    if (!this.httpClient || typeof this.httpClient.delete !== 'function') {
      throw new Error('(unfollowManga) HTTP client delete method is not configured');
    }

    await this.httpClient.delete(endpoint, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    if (this.cacheAdapter && typeof this.cacheAdapter.deleteValue === 'function') {
      await this.cacheAdapter.deleteValue(`mangadex_readingStatus_${seriesId}`);
    }
  }

  /**
   * @param {Record<string, unknown>} mangaCoreEntry
   * @param {{ useCache?: boolean, trackerId?: string, onProgress?: Function, searchTitles?: string[] }} [options]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async searchCovers(mangaCoreEntry, options = {}) {
    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    const trackerId = options && typeof options === 'object' && typeof options.trackerId === 'string'
      ? options.trackerId
      : '';

    const onProgress = options && typeof options === 'object' && typeof options.onProgress === 'function'
      ? options.onProgress
      : null;

    const emitProgress = (status, detail, extra = {}) => {
      if (!onProgress) {
        return;
      }

      onProgress({
        source: SERVICE_NAME,
        status,
        detail,
        timestamp: new Date().toISOString(),
        ...extra,
      });
    };

    if (!mangaCoreEntry || typeof mangaCoreEntry !== 'object' || typeof mangaCoreEntry.title !== 'string') {
      emitProgress('error', 'Invalid manga entry supplied');
      return [];
    }

    const startedAt = Date.now();
    emitProgress('running', 'Searching MangaDex for covers');

    try {
      let mangaId = trackerId;
      let mangaTitle = mangaCoreEntry.title;
      let searchAttempts = trackerId ? 1 : 0;
      let searchCacheHit = false;

      if (!mangaId) {
        const titles = this._buildTitleList(mangaCoreEntry, options);
        const matchResult = await this._findExactMatch(titles, useCache);
        if (!matchResult.match || typeof matchResult.match.id !== 'string') {
          emitProgress('error', `No MangaDex matches for "${mangaCoreEntry.title}"`);
          return [];
        }

        mangaId = matchResult.match.id;
        searchAttempts = matchResult.attempts;
        searchCacheHit = Boolean(matchResult.cacheHit);

        const matchedTitles = this._collectCandidateTitles(matchResult.match);
        if (matchedTitles.length > 0) {
          mangaTitle = matchedTitles[0];
        }
      }

      const coverMeta = { cacheHit: false };
      const covers = await this.getCovers(mangaId, useCache, coverMeta);
      const canonicalUrl = await this.getSeriesUrl(mangaId);
      if (!Array.isArray(covers) || covers.length === 0) {
        emitProgress('complete', `No covers found for MangaDex ID ${mangaId}`, { results: [] });
        return [];
      }

      const fetchedAt = new Date().toISOString();
      const telemetry = {
        durationMs: Date.now() - startedAt,
        cacheHit: Boolean(searchCacheHit || coverMeta.cacheHit),
        attempts: Math.max(searchAttempts, 1),
      };

      const normalized = covers.map((cover) => this._normalizeCoverResult(cover, {
        mangaId,
        mangaTitle,
        canonicalUrl: canonicalUrl || '',
        fetchedAt,
        telemetry,
      }));

      normalized.sort((a, b) => {
        const volumeA = parseFloat(a && a.tracker && typeof a.tracker.volume === 'string' ? a.tracker.volume : '');
        const volumeB = parseFloat(b && b.tracker && typeof b.tracker.volume === 'string' ? b.tracker.volume : '');
        const aValue = Number.isFinite(volumeA) ? volumeA : Number.POSITIVE_INFINITY;
        const bValue = Number.isFinite(volumeB) ? volumeB : Number.POSITIVE_INFINITY;
        return aValue - bValue;
      });

      emitProgress('complete', `Found ${normalized.length} MangaDex cover(s)`, { results: normalized });
      return normalized;
    } catch (error) {
      emitProgress('error', error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  /**
   * @param {{ mangaId?: string, fileName?: string }} metadata
   * @param {string} savePath
   * @returns {Promise<boolean>}
   */
  async downloadCover(metadata, savePath) {
    const mangaId = metadata && typeof metadata === 'object' && typeof metadata.mangaId === 'string'
      ? metadata.mangaId
      : '';
    const fileName = metadata && typeof metadata === 'object' && typeof metadata.fileName === 'string'
      ? metadata.fileName
      : '';

    if (!mangaId || !fileName) {
      return false;
    }

    const cacheKey = `mangadex_downloadCover_${mangaId}_${fileName}`;
    const cachedBase64 = this.cacheAdapter ? await this.cacheAdapter.getValue(cacheKey) : null;
    if (cachedBase64) {
      await fs.writeFile(savePath, Buffer.from(cachedBase64, 'base64'));
      return true;
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(downloadCover) HTTP client get method is not configured');
    }

    try {
      const response = await this.httpClient.get(`https://uploads.mangadex.org/covers/${mangaId}/${fileName}`, {
        responseType: 'arraybuffer',
      });

      const body = response && typeof response === 'object' ? response.data : null;
      const buffer = Buffer.isBuffer(body)
        ? body
        : typeof body === 'string'
          ? Buffer.from(body, 'binary')
          : body && body.buffer
            ? Buffer.from(body.buffer)
            : Buffer.alloc(0);

      if (buffer.length === 0) {
        return false;
      }

      await fs.writeFile(savePath, buffer);
      if (this.cacheAdapter) {
        await this.cacheAdapter.setValue(cacheKey, buffer.toString('base64'), 24 * 60 * 60);
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * @param {Record<string, unknown>} cover
   * @param {{
   *  mangaId: string,
   *  mangaTitle: string,
   *  canonicalUrl: string,
   *  fetchedAt: string,
   *  telemetry: Record<string, unknown>
   * }} context
   * @returns {Record<string, unknown>}
   */
  _normalizeCoverResult(cover, context) {
    const attributes = cover && typeof cover === 'object' && cover.attributes && typeof cover.attributes === 'object'
      ? cover.attributes
      : {};
    const fileName = typeof attributes.fileName === 'string' ? attributes.fileName : '';
    const width = typeof attributes.width === 'number' ? attributes.width : Number(attributes.width);
    const height = typeof attributes.height === 'number' ? attributes.height : Number(attributes.height);
    const hasDimensions = Number.isFinite(width) && Number.isFinite(height);

    return {
      source: SERVICE_NAME,
      title: context.mangaTitle,
      thumbnailUrl: `https://uploads.mangadex.org/covers/${context.mangaId}/${fileName}.256.jpg`,
      canonicalUrl: context.canonicalUrl,
      dimensions: hasDimensions ? { width, height } : undefined,
      tracker: {
        id: context.mangaId,
        url: `https://uploads.mangadex.org/covers/${context.mangaId}/${fileName}`,
        fileName,
        volume: typeof attributes.volume === 'string' ? attributes.volume : '',
        description: typeof attributes.description === 'string' ? attributes.description : context.mangaTitle,
        extras: {
          locale: attributes.locale,
          version: attributes.version,
          relationships: Array.isArray(cover && cover.relationships) ? cover.relationships : [],
        },
      },
      fetchedAt: context.fetchedAt,
      telemetry: { ...context.telemetry },
    };
  }

  /**
   * @param {string[]} titles
   * @param {boolean} useCache
   * @returns {Promise<{ match: Record<string, unknown> | undefined, attempts: number, cacheHit: boolean }>}
   */
  async _findExactMatch(titles, useCache) {
    let attempts = 0;
    let cacheHit = false;
    let fuzzyFallback = null;
    let fuzzySimilarity = 0;

    for (const title of titles) {
      attempts += 1;
      const meta = { cacheHit: false };
      const result = await this.searchManga(title, useCache, meta);
      cacheHit = cacheHit || Boolean(meta.cacheHit);

      const rows = Array.isArray(result && result.data) ? result.data : [];
      for (const row of rows) {
        const candidateTitles = this._collectCandidateTitles(row);
        const similarity = calculateTitleSimilarity(titles, candidateTitles);
        if (similarity.hasExactMatch) {
          return {
            match: row,
            attempts,
            cacheHit,
          };
        }

        if (similarity.bestSimilarity >= 0.6 && similarity.bestSimilarity > fuzzySimilarity) {
          fuzzyFallback = row;
          fuzzySimilarity = similarity.bestSimilarity;
        }
      }
    }

    if (fuzzyFallback) {
      return {
        match: fuzzyFallback,
        attempts,
        cacheHit,
      };
    }

    return {
      match: undefined,
      attempts,
      cacheHit,
    };
  }

  /**
   * @param {Array<Record<string, unknown>>} rows
   * @param {string[]} targetTitles
   * @returns {Array<{ row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number }>}
   */
  _rankSearchRows(rows, targetTitles) {
    /** @type {Array<{ row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number }>} */
    const exactRows = [];
    /** @type {Array<{ row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number }>} */
    const fuzzyRows = [];

    rows.forEach((row, index) => {
      const candidateTitles = this._collectCandidateTitles(row);
      const similarity = calculateTitleSimilarity(targetTitles, candidateTitles);
      if (similarity.hasExactMatch) {
        exactRows.push({ row, matchType: 'exact', similarity: 1, index });
        return;
      }

      if (similarity.bestSimilarity >= 0.6) {
        fuzzyRows.push({ row, matchType: 'fuzzy', similarity: similarity.bestSimilarity, index });
      }
    });

    const prioritized = exactRows.length > 0 ? exactRows : fuzzyRows;
    prioritized.sort((a, b) => {
      if (b.similarity !== a.similarity) {
        return b.similarity - a.similarity;
      }

      return a.index - b.index;
    });

    return prioritized.slice(0, 5);
  }

  /**
   * @param {Record<string, unknown> | string | null | undefined} searchable
   * @param {{ searchTitles?: string[] }} [options]
   * @returns {string[]}
   */
  _buildTitleList(searchable, options = {}) {
    /** @type {string[]} */
    const titles = [];

    const searchTitles = options && typeof options === 'object' && Array.isArray(options.searchTitles)
      ? options.searchTitles
      : [];
    titles.push(...searchTitles);

    if (typeof searchable === 'string') {
      titles.push(searchable);
    } else if (searchable && typeof searchable === 'object') {
      if (typeof searchable.title === 'string') {
        titles.push(searchable.title);
      }
      if (typeof searchable.name === 'string') {
        titles.push(searchable.name);
      }
      if (typeof searchable.alias === 'string') {
        titles.push(searchable.alias);
      }

      const aliases = Array.isArray(searchable.aliases) ? searchable.aliases : [];
      for (const alias of aliases) {
        if (typeof alias === 'string') {
          titles.push(alias);
        }
      }

      const alternatives = Array.isArray(searchable.alternativeTitles) ? searchable.alternativeTitles : [];
      for (const alternative of alternatives) {
        if (typeof alternative === 'string') {
          titles.push(alternative);
        }
      }
    }

    /** @type {string[]} */
    const deduped = [];
    const seen = new Set();
    for (const title of titles) {
      if (typeof title !== 'string') {
        continue;
      }

      const normalized = title.trim();
      if (!normalized) {
        continue;
      }

      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(normalized);
    }

    return deduped;
  }

  /**
   * @param {Record<string, unknown>} row
   * @returns {string[]}
   */
  _collectCandidateTitles(row) {
    /** @type {string[]} */
    const titles = [];
    const attributes = row && typeof row === 'object' && row.attributes && typeof row.attributes === 'object'
      ? row.attributes
      : null;

    if (attributes && attributes.title && typeof attributes.title === 'object') {
      titles.push(
        ...Object.values(attributes.title).filter((entry) => typeof entry === 'string' && entry.trim()),
      );
    }

    if (attributes && Array.isArray(attributes.altTitles)) {
      for (const altRow of attributes.altTitles) {
        if (!altRow || typeof altRow !== 'object') {
          continue;
        }
        titles.push(
          ...Object.values(altRow).filter((entry) => typeof entry === 'string' && entry.trim()),
        );
      }
    }

    /** @type {string[]} */
    const deduped = [];
    const seen = new Set();
    for (const title of titles) {
      const normalized = title.trim();
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(normalized);
    }

    return deduped;
  }

  /**
   * @param {string|number} trackerId
   * @returns {Promise<string|null>}
   */
  async getSeriesUrl(trackerId) {
    if (!trackerId) {
      return null;
    }

    return `https://mangadex.org/title/${trackerId}`;
  }
}

MangaDexAPIWrapper.serviceName = SERVICE_NAME;

module.exports = MangaDexAPIWrapper;
