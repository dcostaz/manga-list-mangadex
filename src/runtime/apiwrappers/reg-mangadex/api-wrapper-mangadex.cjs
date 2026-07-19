'use strict';

const fs = require('fs').promises;
const path = require('path');
const MangaDexAPISettings = require(path.join(__dirname, 'api-settings-mangadex.cjs'));

const SERVICE_NAME = 'mangadex';

/** @typedef {import('../../../../types/plugintypedefs').PluginServiceSettings} PluginServiceSettings */
/** @typedef {import('../../../../types/plugintypedefs').MangaDexAPIWrapperCtorParams} MangaDexAPIWrapperCtorParams */
/** @typedef {import('../../../../types/plugintypedefs').MangaDexAPIWrapperInitOptions} MangaDexAPIWrapperInitOptions */
/** @typedef {import('../../../../types/plugintypedefs').MangaDexRawSearchResponse} MangaDexRawSearchResponse */
/** @typedef {import('../../../../types/plugintypedefs').MangaDexRawEntityResponse} MangaDexRawEntityResponse */
/** @typedef {import('../../../../types/plugintypedefs').TrackerHttpClientLike} TrackerHttpClientLike */
/** @typedef {import('../../../../types/plugintypedefs').PluginCredential} PluginCredential */
/** @typedef {import('../../../../types/plugincontexttypedefs').PluginContextLike} PluginContextLike */

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
 * @param {string} html
 * @returns {string}
 */
function extractHtmlErrorMessage(html) {
  if (typeof html !== 'string') {
    return 'HTML error response';
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && typeof titleMatch[1] === 'string' && titleMatch[1].trim()) {
    return titleMatch[1].trim();
  }

  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return bodyText ? bodyText.slice(0, 180) : 'HTML error response';
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
 * @param {string[]} expectedTitles
 * @param {string[]} candidateTitles
 * @returns {{ hasExactMatch: boolean, bestSimilarity: number }}
 */
function calculateTitleSimilarity(expectedTitles, candidateTitles, containmentScore = 0.85) {
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
        similarity = containmentScore;
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
   * @param {object} [params]
   * @param {MangaDexAPISettings | null} [params.apiSettings]
   * @param {PluginServiceSettings} [params.serviceSettings]
   * @param {TrackerHttpClientLike | null} [params.httpClient]
   * @param {PluginContextLike | null} [params.context]
   */
  constructor(params = {}) {
    const apiSettings = params && typeof params === 'object' ? params.apiSettings : null;
    const serviceSettings = params && typeof params === 'object' ? params.serviceSettings : null;
    const providedHttpClient = params && typeof params === 'object'
      ? params.httpClient
      : null;
    const providedContext = params && typeof params === 'object' ? params.context : null;

    this.settings = serviceSettings && typeof serviceSettings === 'object' ? serviceSettings : {};
    this.apiSettings = apiSettings instanceof MangaDexAPISettings ? apiSettings : null;

    this._defaultTokenName = 'access_token';
    this.bearerToken = null;
    this.credentials = null;
    this._context = providedContext && typeof providedContext === 'object' ? providedContext : null;
    this._initialized = false;
    // axios.create() returns a callable function (it supports both instance(config)
    // and instance.get(url)), so typeof is 'function', not 'object' — accept both.
    this.httpClient = providedHttpClient && (typeof providedHttpClient === 'object' || typeof providedHttpClient === 'function')
      ? providedHttpClient
      : createDefaultHttpClient();

    this._setupAxiosInterceptor();
  }

  // ---------------------------------------------------------------------------
  // PluginAPILike lifecycle
  // ---------------------------------------------------------------------------

  static get pluginName() { return SERVICE_NAME; }
  get pluginName() { return SERVICE_NAME; }
  get pluginType() { return Object.freeze(['tracker']); }
  get capabilities() { return Object.freeze(['tracker.search', 'tracker.sync', 'tracker.cover', 'localtracker.enrich']); }

  /** Credential fields the host renders in the plugin credential form. */
  get credentialSchema() {
    return Object.freeze([
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'client_id', label: 'Client ID', type: 'text' },
      { key: 'client_secret', label: 'Client Secret', type: 'password' },
    ]);
  }
  get contractVersion() {
    const { PLUGIN_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'plugindtocontract.cjs'));
    return PLUGIN_CONTRACT_VERSION;
  }

  async initialize() {
    this._initialized = true;
    return { status: 'ok' };
  }

  getStatus() {
    return { status: this._initialized ? 'ok' : 'initializing' };
  }

  /**
   * @param {PluginCredential} current
   * @returns {Promise<PluginCredential>}
   */
  async refreshCredentials(current) {
    if (!current || typeof current !== 'object') {
      throw new Error('(refreshCredentials) current credential is required');
    }
    const credentials = { username: current.username || '', password: current.password || '' };
    const tokenData = await this._fetchNewToken(credentials, { forceRefresh: true });
    const accessToken = await this._extractToken(tokenData);
    const refreshKey = this._getTokenCacheKey('refresh_token');
    let refreshToken = current.refreshToken || null;
    if (this._context && this._context.cache) {
      const cached = await this._context.cache.getValue(refreshKey, { userScoped: true });
      if (cached) refreshToken = cached;
    }
    return {
      token: accessToken || '',
      refreshToken: refreshToken || null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * @returns {void}
   */
  _setupAxiosInterceptor() {
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

        const cleanError = new Error(
          `MangaDex backend infrastructure error: ${extractHtmlErrorMessage(typeof responseData === 'string' ? responseData : '')}`,
        );
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
   * @param {object} [options]
   * @param {MangaDexAPISettings | null} [options.apiSettings]
   * @param {PluginServiceSettings} [options.serviceSettings]
   * @param {TrackerHttpClientLike | null} [options.httpClient]
   * @param {Function | null} [options.httpClientFactory]
   * @param {PluginContextLike | null} [options.context]
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

    // axios.create() returns a callable function, so typeof is 'function', not 'object'.
    const directHttpClient = options && typeof options === 'object' && options.httpClient
      && (typeof options.httpClient === 'object' || typeof options.httpClient === 'function')
      ? options.httpClient
      : null;
    const httpClientFactory = options && typeof options === 'object' && typeof options.httpClientFactory === 'function'
      ? options.httpClientFactory
      : null;
    const httpClientFromFactory = !directHttpClient && httpClientFactory ? httpClientFactory() : null;

    const context = options && typeof options === 'object' && options.context && typeof options.context === 'object'
      ? options.context
      : null;

    return new MangaDexAPIWrapper({
      apiSettings: resolvedApiSettings,
      serviceSettings,
      httpClient: directHttpClient || httpClientFromFactory || null,
      context,
    });
  }

  /**
   * @returns {string}
   */
  static get serviceName() {
    return SERVICE_NAME;
  }

  /**
   * @returns {Promise<PluginCredential | null>}
   */
  async getCredentials() {
    return this.credentials && typeof this.credentials === 'object'
      ? { ...this.credentials }
      : null;
  }

  /**
   * @param {PluginCredential} credentials
   * @returns {Promise<PluginCredential>}
   */
  async setCredentials(credentials) {
    if (!credentials || typeof credentials !== 'object') {
      throw new Error('Credentials must be an object.');
    }

    this.credentials = { ...credentials };
    return { ...this.credentials };
  }

  /**
   * @param {PluginCredential} credentials
   * @returns {Promise<boolean>}
   */
  async testCredentials(credentials) {
    try {
      const token = await this._fetchNewToken(credentials, { forceRefresh: true });
      return token && typeof token.access_token === 'string' && token.access_token.length > 0;
    } catch (error) {
      return false;
    }
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
    if (!this._context || !this._context.cache || typeof this._context.cache.getValue !== 'function') {
      return null;
    }

    const raw = await this._context.cache.getValue(key);
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
    if (!this._context || !this._context.cache || typeof this._context.cache.setValue !== 'function') {
      return;
    }

    await this._context.cache.setValue(key, JSON.stringify(value), ttlSeconds);
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

    if (!forceRefresh && (this._context && this._context.cache)) {
      const cached = await this._context.cache.getValue(accessKey, { userScoped: true });
      if (cached) {
        this.bearerToken = cached;
        return cached;
      }
    }

    let credentials = await this.getCredentials();

    if (!credentials) {
      throw new Error('Credentials not found.');
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
   * @param {PluginCredential} credentials
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {Promise<Record<string, string>>}
   */
  async _fetchNewToken(credentials, options = {}) {
    const forceRefresh = options && typeof options === 'object' && options.forceRefresh === true;
    const refreshKey = this._getTokenCacheKey('refresh_token');
    const cachedRefreshToken = forceRefresh ? null : ((this._context && this._context.cache) ? await this._context.cache.getValue(refreshKey, { userScoped: true }) : null);
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
    // credentialSchema declares these as 'client_id'/'client_secret' (matching
    // what the stored credential object actually contains) — not camelCase.
    params.append('client_id', credentials.client_id || '');
    params.append('client_secret', credentials.client_secret || '');

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
        if ((this._context && this._context.cache) && typeof this._context.cache.deleteValue === 'function') {
          await this._context.cache.deleteValue(refreshKey, { userScoped: true });
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
    if (!tokenData || typeof tokenData !== 'object' || !(this._context && this._context.cache)) {
      return;
    }

    if (typeof tokenData.access_token === 'string' && tokenData.access_token) {
      await this._context.cache.setValue(
        this._getTokenCacheKey('access_token'),
        tokenData.access_token,
        this._getTokenTTL('access_token'),
        { userScoped: true },
      );
      this.bearerToken = tokenData.access_token;
    }

    if (typeof tokenData.refresh_token === 'string' && tokenData.refresh_token) {
      await this._context.cache.setValue(
        this._getTokenCacheKey('refresh_token'),
        tokenData.refresh_token,
        this._getTokenTTL('refresh_token'),
        { userScoped: true },
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

    const bestSnapshot = await this._selectBestSearchSnapshot(targetTitles, {
      useCache,
      limit: 5,
      stopOnExact: true,
    });

    if (bestSnapshot && Array.isArray(bestSnapshot.rows) && bestSnapshot.rows.length > 0) {
      const mapped = (await Promise.all(
        bestSnapshot.rows.map(async (row) => {
          const rowData = row && typeof row === 'object' && row.row && typeof row.row === 'object'
            ? row.row
            : null;
          const rowId = rowData && typeof rowData.id === 'string' ? rowData.id : null;

          if (!rowId) {
            return null;
          }

          let normalizedRow = rowData;
          try {
            const detail = await this.getMangaById(rowId, useCache);
            const detailData = detail && typeof detail === 'object' && detail.data && typeof detail.data === 'object'
              ? detail.data
              : null;
            const detailAttributes = detailData && detailData.attributes && typeof detailData.attributes === 'object'
              ? detailData.attributes
              : null;
            const hasDetailTitle = detailAttributes && detailAttributes.title && typeof detailAttributes.title === 'object'
              && Object.values(detailAttributes.title).some((entry) => typeof entry === 'string' && entry.trim());
            if (detailData && hasDetailTitle) {
              normalizedRow = detailData;
            }
          } catch {
            // Keep ranked search row when detail hydration fails.
          }

          const attributes = normalizedRow && normalizedRow.attributes && typeof normalizedRow.attributes === 'object'
            ? normalizedRow.attributes
            : null;
          const titleValues = attributes && attributes.title && typeof attributes.title === 'object'
            ? Object.values(attributes.title).filter((entry) => typeof entry === 'string' && entry.trim())
            : [];

          if (titleValues.length === 0) {
            return null;
          }

          let resolvedCoverUrl = normalizedRow && typeof normalizedRow.coverUrl === 'string'
            ? normalizedRow.coverUrl.trim()
            : '';

          if (!resolvedCoverUrl) {
            try {
              const covers = await this.getCovers(rowId, useCache);
              if (Array.isArray(covers) && covers.length > 0) {
                const first = covers[0] && covers[0].attributes && typeof covers[0].attributes === 'object'
                  ? covers[0].attributes
                  : null;
                const fileName = first && typeof first.fileName === 'string' ? first.fileName : '';
                if (fileName) {
                  resolvedCoverUrl = `https://uploads.mangadex.org/covers/${rowId}/${fileName}.256.jpg`;
                }
              }
            } catch {
              // Keep raw search rows usable even if cover lookup is unavailable.
            }
          }

          return {
            ...normalizedRow,
            id: rowId,
            title: String(titleValues[0]),
            coverUrl: resolvedCoverUrl,
          };
        }),
      )).filter((row) => row !== null);

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
   * @param {string} query
   * @param {{ useCache?: boolean, searchTitles?: string[] }} [_options]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async search(query, _options = {}) {
    const useCache = !(_options && typeof _options === 'object' && _options.useCache === false);
    const targetTitles = this._buildTitleList(typeof query === 'string' ? query : '', {});

    const bestSnapshot = await this._selectBestSearchSnapshot(targetTitles, {
      useCache,
      limit: 5,
      stopOnExact: true,
    });

    if (bestSnapshot && Array.isArray(bestSnapshot.rows) && bestSnapshot.rows.length > 0) {
      const normalized = await Promise.all(
        bestSnapshot.rows.map(async (entry) => {
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
    const cacheKey = `mangadex_searchManga_${(this._context ? this._context.utils.sanitizeForSearch(title) : toSlug(title))}`;
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
    // MangaDex represents both authors and artists as 'author' resources; the
    // role ('author' vs 'artist') only exists on the manga's relationship entry,
    // not the resource itself — track it by id so it survives the lookup.
    const authorRelationships = relationships
      .filter((rel) => rel && typeof rel === 'object' && (rel.type === 'author' || rel.type === 'artist'));
    const authorIds = authorRelationships
      .map((rel) => rel.id)
      .filter((id) => typeof id === 'string');
    const roleById = new Map(authorRelationships.map((rel) => [rel.id, rel.type === 'artist' ? 'Artist' : 'Author']));

    const authorRows = authorIds.length > 0 ? await this.getAuthors(authorIds, useCache) : [];
    const contributors = authorRows
      .map((row) => {
        const name = row && row.attributes && typeof row.attributes === 'object' ? row.attributes.name : null;
        if (typeof name !== 'string' || !name.trim()) return null;
        return { name: name.trim(), type: roleById.get(row.id) || 'Author' };
      })
      .filter((entry) => entry !== null);
    const authorContributors = contributors.filter((c) => c.type === 'Author');
    const artistContributors = contributors.filter((c) => c.type === 'Artist');

    const tags = manga && manga.attributes && typeof manga.attributes === 'object' && Array.isArray(manga.attributes.tags)
      ? manga.attributes.tags
      : [];
    const tagName = (tag) => (tag && typeof tag === 'object' && tag.attributes && typeof tag.attributes === 'object'
      && tag.attributes.name && typeof tag.attributes.name === 'object' && typeof tag.attributes.name.en === 'string'
      ? tag.attributes.name.en.trim()
      : null);
    const genreNames = tags
      .filter((t) => t && typeof t === 'object' && t.attributes && t.attributes.group === 'genre')
      .map(tagName)
      .filter((n) => typeof n === 'string' && n);
    const otherTagNames = tags
      .filter((t) => t && typeof t === 'object' && t.attributes && t.attributes.group !== 'genre')
      .map(tagName)
      .filter((n) => typeof n === 'string' && n);
    const formatTagNames = tags
      .filter((t) => t && typeof t === 'object' && t.attributes && t.attributes.group === 'format')
      .map(tagName)
      .filter((n) => typeof n === 'string' && n);

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
      pluginEntryId: typeof manga.id === 'string' ? manga.id : null,
      title: mainTitleValues.length > 0 ? String(mainTitleValues[0]) : '',
      alternativeTitles: altTitles,
      coverUrl,
      metadata: {
        year: manga && manga.attributes && typeof manga.attributes === 'object' && typeof manga.attributes.year === 'number'
          ? manga.attributes.year
          : null,
        type: formatTagNames.length > 0 ? formatTagNames[0] : 'Manga',
        description: manga && manga.attributes && typeof manga.attributes === 'object' && manga.attributes.description
          && typeof manga.attributes.description === 'object' && typeof manga.attributes.description.en === 'string'
          ? manga.attributes.description.en
          : '',
        status: manga && manga.attributes && typeof manga.attributes === 'object' && typeof manga.attributes.status === 'string'
          ? manga.attributes.status
          : null,
        relationships,
        authors: authorContributors,
        artists: artistContributors,
        genres: genreNames,
        tags: otherTagNames,
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
      // Real failures (network/auth) must propagate so the host surfaces the
      // actual cause instead of a generic "no contribution" message; only an
      // explicit null (not-found) means "no data".
      console.error(`[mangadex] getSeriesById(${trackerId}) failed:`, error instanceof Error ? error.message : error);
      throw error;
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

    const resolvedTrackerId = typeof manga.id === 'string' ? manga.id : String(trackerId || '');
    let covers = [];
    if (typeof manga.id === 'string') {
      try {
        covers = await this.getCovers(manga.id, useCache);
      } catch (error) {
        covers = [];
      }
    }
    const firstCover = Array.isArray(covers) && covers.length > 0 && covers[0] && typeof covers[0] === 'object'
      ? covers[0]
      : null;
    const firstAttributes = firstCover && firstCover.attributes && typeof firstCover.attributes === 'object'
      ? firstCover.attributes
      : null;
    const fileName = firstAttributes && typeof firstAttributes.fileName === 'string'
      ? firstAttributes.fileName
      : null;
    const coverBaseUrl = resolvedTrackerId && fileName
      ? `https://uploads.mangadex.org/covers/${resolvedTrackerId}/${fileName}`
      : null;
    const coverPayload = coverBaseUrl
      ? {
        trackerId: resolvedTrackerId,
        coverUrl: coverBaseUrl,
        thumbnailUrl: `${coverBaseUrl}.256.jpg`,
        fileName,
      }
      : null;

    return {
      trackerId: SERVICE_NAME,
      operation: 'getSeriesByIdRaw',
      payload: {
        id: resolvedTrackerId,
        title: titleValues.length > 0 ? String(titleValues[0]) : '',
        data: manga,
        cover: coverPayload,
        covers: coverPayload ? [coverPayload] : [],
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
    if (useCache && (this._context && this._context.cache)) {
      const cached = await this._context.cache.getValue(cacheKey, { userScoped: true });
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
      if (status && (this._context && this._context.cache)) {
        await this._context.cache.setValue(cacheKey, status, 60 * 60, { userScoped: true });
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
   * @param {string|number} pluginEntryId
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async pullProgress(pluginEntryId) {
    const status = await this.getReadingStatus(pluginEntryId, true);
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
      chapter: null,
      volume: null,
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

    if (this._context && this._context.cache) {
      await this._context.cache.setValue(`mangadex_readingStatus_${trackerId}`, status, 60 * 60, { userScoped: true });
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
   * @param {string} pluginEntryId
   * @param {object | null} [context]
   * @param {string | null} [context.readingStatus]
   * @param {number} [context.chapter]
   * @param {number} [context.volume]
   * @param {number} [context.rating]
   * @returns {Promise<void>}
   */
  async subscribe(pluginEntryId, context) {
    const seriesId = pluginEntryId;
    const status = context && context.readingStatus ? context.readingStatus : null;

    if (!seriesId) {
      throw new Error('(subscribe) pluginEntryId is required');
    }

    await this.getToken();

    const followEndpoint = this._resolveEndpoint('api.endpoints.follow.template', {
      id: String(seriesId),
    });
    const statusEndpoint = this._resolveEndpoint('api.endpoints.status.template', {
      id: String(seriesId),
    });
    if (!followEndpoint || !statusEndpoint) {
      throw new Error('(subscribe) Missing follow or status endpoint config');
    }

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(subscribe) HTTP client post method is not configured');
    }

    await this.httpClient.post(followEndpoint, {}, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    if (!status || typeof status !== 'string') {
      return { success: true, mode: 'subscribed', listId: null };
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

    if (this._context && this._context.cache) {
      await this._context.cache.setValue(`mangadex_readingStatus_${seriesId}`, mappedStatus, 60 * 60, { userScoped: true });
    }

    return { success: true, mode: 'subscribed', listId: null };
  }

  /**
   * @param {string|number} pluginEntryId
   * @param {Record<string, unknown>} [progress]
   * @returns {Promise<Record<string, unknown>>}
   */
  async pushProgress(pluginEntryId, progress = {}) {
    if (!pluginEntryId) {
      throw new Error('(pushProgress) pluginEntryId is required');
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

    await this.updateStatus(pluginEntryId, mappedStatus);
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

    if ((this._context && this._context.cache) && typeof this._context.cache.deleteValue === 'function') {
      await this._context.cache.deleteValue(`mangadex_readingStatus_${seriesId}`, { userScoped: true });
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
      /** @type {'exact' | 'fuzzy'} */
      let matchType = trackerId ? 'exact' : 'fuzzy';
      let similarity = trackerId ? 1 : 0;

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
        matchType = matchResult.matchType === 'exact' ? 'exact' : 'fuzzy';
        similarity = typeof matchResult.similarity === 'number' && Number.isFinite(matchResult.similarity)
          ? matchResult.similarity
          : 0;

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
      const score = this._resolveCoverSearchScore(matchType, similarity);

      const normalized = covers.map((cover) => this._normalizeCoverResult(cover, {
        mangaId,
        mangaTitle,
        canonicalUrl: canonicalUrl || '',
        fetchedAt,
        telemetry,
        matchType,
        score,
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
    const cachedBase64 = (this._context && this._context.cache) ? await this._context.cache.getValue(cacheKey) : null;
    if (cachedBase64) {
      await fs.mkdir(path.dirname(savePath), { recursive: true });
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

      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, buffer);
      if (this._context && this._context.cache) {
        await this._context.cache.setValue(cacheKey, buffer.toString('base64'), 24 * 60 * 60);
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
   *  telemetry: Record<string, unknown>,
   *  matchType?: 'exact' | 'fuzzy',
   *  score?: number,
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
        score: typeof context.score === 'number' ? context.score : undefined,
        extras: {
          matchType: context.matchType === 'exact' ? 'exact' : 'fuzzy',
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
   * @returns {Promise<{
   *  match: Record<string, unknown> | undefined,
   *  attempts: number,
   *  cacheHit: boolean,
   *  matchType: 'exact' | 'fuzzy',
   *  similarity: number,
   * }>}
   */
  async _findExactMatch(titles, useCache) {
    const bestSnapshot = await this._selectBestSearchSnapshot(titles, {
      useCache,
      limit: 5,
      stopOnExact: true,
    });

    if (bestSnapshot && bestSnapshot.bestRow && bestSnapshot.bestRow.row) {
      return {
        match: bestSnapshot.bestRow.row,
        attempts: bestSnapshot.attempts,
        cacheHit: bestSnapshot.cacheHit,
        matchType: bestSnapshot.bestRow.matchType,
        similarity: bestSnapshot.bestRow.similarity,
      };
    }

    return {
      match: undefined,
      attempts: bestSnapshot ? bestSnapshot.attempts : 0,
      cacheHit: bestSnapshot ? bestSnapshot.cacheHit : false,
      matchType: 'fuzzy',
      similarity: 0,
    };
  }

  /**
   * @param {'exact' | 'fuzzy'} matchType
   * @param {number} similarity
   * @returns {number}
   */
  _resolveCoverSearchScore(matchType, similarity) {
    if (matchType === 'exact') {
      return 100;
    }

    const boundedSimilarity = typeof similarity === 'number' && Number.isFinite(similarity)
      ? Math.max(0, Math.min(1, similarity))
      : 0.8;
    return Math.max(70, Math.min(95, Math.round(boundedSimilarity * 100)));
  }

  /**
   * Evaluate all candidate query titles and retain the best-ranked snapshot.
   * Stops early only when an exact (100%) match appears.
   * @param {string[]} targetTitles
   * @param {{ useCache: boolean, limit: number, stopOnExact?: boolean }} options
   * @returns {Promise<{
   *  title: string,
   *  rows: Array<{ row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number }>,
   *  bestRow: { row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number } | null,
   *  attempts: number,
   *  cacheHit: boolean,
   * } | null>}
   */
  async _selectBestSearchSnapshot(targetTitles, options) {
    const normalizedTitles = Array.isArray(targetTitles)
      ? targetTitles.filter((title) => typeof title === 'string' && title.trim().length > 0)
      : [];
    if (normalizedTitles.length === 0) {
      return null;
    }

    const exactMatchPolicyRaw = this._resolveSettingValue('search.exactMatchPolicy');
    const stopOnExact = exactMatchPolicyRaw === 'highestScore' ? false : !!(options && options.stopOnExact);
    const candidateLimitRaw = this._resolveSettingValue('search.candidateLimit');
    const candidateLimit = typeof candidateLimitRaw === 'number' && Number.isFinite(candidateLimitRaw) && candidateLimitRaw > 0
      ? Math.trunc(candidateLimitRaw)
      : 5;
    const limit = Number.isFinite(options?.limit) && options.limit > 0
      ? Math.trunc(options.limit)
      : candidateLimit;

    /** @type {{
     *  title: string,
     *  rows: Array<{ row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number }>,
     *  bestRow: { row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number } | null,
     *  attempts: number,
     *  cacheHit: boolean,
     * } | null} */
    let bestSnapshot = null;

    let attempts = 0;
    let cacheHit = false;

    for (const title of normalizedTitles) {
      attempts += 1;
      const meta = { cacheHit: false };
      const searchResult = await this.searchManga(title, options?.useCache !== false, meta);
      cacheHit = cacheHit || Boolean(meta.cacheHit);

      const rows = Array.isArray(searchResult && searchResult.data)
        ? searchResult.data
        : [];
      if (rows.length === 0) {
        continue;
      }

      const ranked = this._rankSearchRows(rows, normalizedTitles);
      if (ranked.length === 0) {
        continue;
      }

      const topRows = ranked.slice(0, limit);
      const bestRow = topRows.length > 0 ? topRows[0] : null;
      if (!bestRow) {
        continue;
      }

      const snapshot = {
        title,
        rows: topRows,
        bestRow,
        attempts,
        cacheHit,
      };

      if (!bestSnapshot) {
        bestSnapshot = snapshot;
      } else {
        const currentRank = this._resolveMatchTypeRank(bestSnapshot.bestRow ? bestSnapshot.bestRow.matchType : 'fuzzy');
        const nextRank = this._resolveMatchTypeRank(bestRow.matchType);

        if (nextRank < currentRank) {
          bestSnapshot = snapshot;
        } else if (nextRank === currentRank) {
          const currentSimilarity = bestSnapshot.bestRow ? bestSnapshot.bestRow.similarity : 0;
          if (bestRow.similarity > currentSimilarity) {
            bestSnapshot = snapshot;
          }
        }
      }

      if (stopOnExact && bestRow.matchType === 'exact') {
        return {
          ...snapshot,
          attempts,
          cacheHit,
        };
      }
    }

    if (!bestSnapshot) {
      return {
        title: '',
        rows: [],
        bestRow: null,
        attempts,
        cacheHit,
      };
    }

    return {
      ...bestSnapshot,
      attempts,
      cacheHit,
    };
  }

  /**
   * @param {'exact'|'fuzzy'} matchType
   * @returns {number}
   */
  _resolveMatchTypeRank(matchType) {
    if (matchType === 'exact') {
      return 0;
    }

    return 1;
  }

  /**
   * @param {Array<Record<string, unknown>>} rows
   * @param {string[]} targetTitles
   * @returns {Array<{ row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number }>}
   */
  _rankSearchRows(rows, targetTitles) {
    const fuzzyThresholdRaw = this._resolveSettingValue('search.fuzzyThreshold');
    const fuzzyThreshold = typeof fuzzyThresholdRaw === 'number' && Number.isFinite(fuzzyThresholdRaw) && fuzzyThresholdRaw > 0
      ? fuzzyThresholdRaw
      : 0.60;
    const containmentScoreRaw = this._resolveSettingValue('search.containmentScore');
    const containmentScore = typeof containmentScoreRaw === 'number' && Number.isFinite(containmentScoreRaw)
      ? containmentScoreRaw
      : 0.85;
    const candidateLimitRaw = this._resolveSettingValue('search.candidateLimit');
    const candidateLimit = typeof candidateLimitRaw === 'number' && Number.isFinite(candidateLimitRaw) && candidateLimitRaw > 0
      ? Math.trunc(candidateLimitRaw)
      : 5;
    /** @type {Array<{ row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number }>} */
    const exactRows = [];
    /** @type {Array<{ row: Record<string, unknown>, matchType: 'exact' | 'fuzzy', similarity: number, index: number }>} */
    const fuzzyRows = [];

    rows.forEach((row, index) => {
      const candidateTitles = this._collectCandidateTitles(row);
      const similarity = calculateTitleSimilarity(targetTitles, candidateTitles, containmentScore);
      if (similarity.hasExactMatch) {
        exactRows.push({ row, matchType: 'exact', similarity: 1, index });
        return;
      }

      if (similarity.bestSimilarity >= fuzzyThreshold) {
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

    return prioritized.slice(0, candidateLimit);
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

  // ---------------------------------------------------------------------------
  // adapter.enrich methods
  // ---------------------------------------------------------------------------

  /**
   * @param {string} title
   * @param {object} [_options]
   * @returns {Promise<Array<{ pluginEntryId: string, title: string, altTitles: string[], confidence: number }>>}
   */
  async findMatches(title, _options) {
    const q = typeof title === 'string' ? title : '';
    if (!q.trim()) return [];
    try {
      const results = await this.search(q);
      return results.slice(0, 5).map((r) => ({
        pluginEntryId: String(r.trackerId || r.pluginEntryId || ''),
        title: typeof r.title === 'string' ? r.title : q,
        altTitles: Array.isArray(r.alternativeTitles) ? r.alternativeTitles : [],
        confidence: typeof r.confidence === 'number' ? r.confidence : 0,
        coverUrl: typeof r.coverUrl === 'string' ? r.coverUrl : undefined,
      }));
    } catch (error) {
      return [];
    }
  }

  /**
   * Map a MangaDex publication status to the PluginLinkContribution seriesStatus enum.
   * @param {unknown} status
   * @returns {'ongoing' | 'completed' | 'hiatus' | 'unknown'}
   */
  _mapSeriesStatus(status) {
    const s = typeof status === 'string' ? status.toLowerCase() : '';
    if (s === 'completed') return 'completed';
    if (s === 'hiatus') return 'hiatus';
    if (s === 'ongoing') return 'ongoing';
    return 'unknown';
  }

  // ── plugin.live ──

  /**
   * @param {string} pluginEntryId
   * @returns {Promise<import('../../../../types/plugintypedefs').PluginLiveQueryResult>}
   */
  async queryLive(pluginEntryId) {
    let series;
    try {
      series = await this.getSeriesById(pluginEntryId, false);
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error), retryable: true };
    }
    if (!series) return { status: 'not_found' };

    const md = series.metadata && typeof series.metadata === 'object' ? series.metadata : {};
    let seriesUrl = null;
    try { seriesUrl = await this.getSeriesUrl(pluginEntryId); } catch { seriesUrl = null; }

    return {
      status: 'ok',
      data: {
        pluginEntryId: String(pluginEntryId),
        displayTitle: typeof series.title === 'string' ? series.title : undefined,
        linkState: 'active',
        statusLabel: typeof md.status === 'string' ? md.status : undefined,
        fetchedAt: new Date().toISOString(),
        sections: [
          {
            type: 'stat-grid',
            label: 'Overview',
            fields: {
              'Series status': typeof md.status === 'string' ? md.status : '—',
              'Type': typeof md.type === 'string' ? md.type : '—',
              'Year': typeof md.year === 'number' ? md.year : '—',
              'Alt titles': Array.isArray(series.alternativeTitles) ? series.alternativeTitles.length : 0,
            },
          },
          ...(seriesUrl ? [{
            type: 'link-list',
            label: 'Links',
            links: [{ label: 'MangaDex', url: seriesUrl }],
          }] : []),
        ],
      },
    };
  }

  /**
   * Build a PluginLinkContribution for a linked MangaDex series. Re-fetches
   * stable metadata (cover, titles, authors/artists, genres, status) from the
   * manga detail endpoint and the canonical series URL.
   * @param {string} pluginEntryId - MangaDex manga id
   * @returns {Promise<import('../../../../types/plugintypedefs').PluginLinkContribution | null>}
   */
  async buildLinkContribution(pluginEntryId) {
    const series = await this.getSeriesById(pluginEntryId, true);
    if (!series) return null;
    const md = series.metadata && typeof series.metadata === 'object' ? series.metadata : {};

    let seriesUrl = null;
    try { seriesUrl = await this.getSeriesUrl(pluginEntryId); } catch { seriesUrl = null; }

    /** @type {import('../../../../types/plugintypedefs').PluginLinkContribution} */
    const contribution = {
      pluginEntryId: String(pluginEntryId),
      syncedAt: new Date().toISOString(),
      seriesStatus: this._mapSeriesStatus(md.status),
    };
    if (series.title) contribution.displayTitle = series.title;
    if (Array.isArray(series.alternativeTitles) && series.alternativeTitles.length) contribution.altTitles = series.alternativeTitles;
    if (Array.isArray(md.authors) && md.authors.length) contribution.authors = md.authors;
    if (Array.isArray(md.artists) && md.artists.length) contribution.artists = md.artists;
    if (Array.isArray(md.genres) && md.genres.length) contribution.genres = md.genres;
    if (Array.isArray(md.tags) && md.tags.length) contribution.tags = md.tags;
    if (md.description) contribution.description = md.description;
    if (series.coverUrl) contribution.coverUrl = series.coverUrl;
    if (typeof md.year === 'number' && Number.isFinite(md.year)) contribution.year = md.year;
    if (typeof md.type === 'string' && md.type) contribution.seriesType = md.type;
    contribution.sourceLinks = seriesUrl
      ? [{ siteId: SERVICE_NAME, siteLabel: 'MangaDex', seriesUrl, isPrimary: true }]
      : [];
    return contribution;
  }

  /**
   * Same enrichment as buildLinkContribution, resolving the manga id from the
   * supplied LocalTrackerEntry (host passes the linked pluginEntryId).
   * @param {{ pluginEntryId?: string, trackerId?: string }} localTrackerEntry
   * @returns {Promise<import('../../../../types/plugintypedefs').PluginLinkContribution | null>}
   */
  async syncEnrichment(localTrackerEntry) {
    const pluginEntryId = localTrackerEntry && (localTrackerEntry.pluginEntryId || localTrackerEntry.trackerId);
    if (!pluginEntryId) return null;
    return this.buildLinkContribution(pluginEntryId);
  }
}

module.exports = MangaDexAPIWrapper;
