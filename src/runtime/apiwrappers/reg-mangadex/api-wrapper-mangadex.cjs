'use strict';

const path = require('path');
const MangaDexAPISettings = require(path.join(__dirname, 'api-settings-mangadex.cjs'));

/** @typedef {import('../../../../types/trackertypedefs').TrackerServiceSettings} TrackerServiceSettings */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexAPIWrapperCtorParams} MangaDexAPIWrapperCtorParams */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexAPIWrapperInitOptions} MangaDexAPIWrapperInitOptions */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexRawSearchResponse} MangaDexRawSearchResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexRawEntityResponse} MangaDexRawEntityResponse */

class MangaDexAPIWrapper {
  /**
  * @param {MangaDexAPIWrapperCtorParams} [params]
   * @param {MangaDexAPISettings | null} [params.apiSettings]
  * @param {TrackerServiceSettings} [params.serviceSettings]
   */
  constructor(params = {}) {
    const apiSettings = params && typeof params === 'object' ? params.apiSettings : null;
    const serviceSettings = params && typeof params === 'object' ? params.serviceSettings : null;

    this.settings = serviceSettings && typeof serviceSettings === 'object' ? serviceSettings : {};
    this.apiSettings = apiSettings instanceof MangaDexAPISettings ? apiSettings : null;
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

    return new MangaDexAPIWrapper({
      apiSettings,
      serviceSettings: options && typeof options === 'object' ? options.serviceSettings : null,
    });
  }

  /**
   * @param {string} query
  * @returns {Promise<MangaDexRawSearchResponse>}
   */
  async searchTrackersRaw(query) {
    const normalizedQuery = typeof query === 'string' ? query.trim() : '';
    const items = normalizedQuery
      ? [{ id: `mdx-${normalizedQuery.toLowerCase()}`, title: normalizedQuery }]
      : [];

    return {
      trackerId: 'mangadex',
      operation: 'searchTrackersRaw',
      payload: { data: items },
    };
  }

  /**
   * @param {string} trackerId
  * @returns {Promise<MangaDexRawEntityResponse>}
   */
  async getSeriesByIdRaw(trackerId) {
    const normalizedTrackerId = typeof trackerId === 'string' ? trackerId.trim() : '';
    return {
      trackerId: 'mangadex',
      operation: 'getSeriesByIdRaw',
      payload: {
        id: normalizedTrackerId || 'unknown',
        title: normalizedTrackerId || 'Unknown MangaDex Title',
      },
    };
  }

  /**
   * @param {string} trackerId
  * @returns {Promise<MangaDexRawEntityResponse>}
   */
  async getUserProgressRaw(trackerId) {
    const normalizedTrackerId = typeof trackerId === 'string' ? trackerId.trim() : '';
    return {
      trackerId: 'mangadex',
      operation: 'getUserProgressRaw',
      payload: {
        trackerId: normalizedTrackerId || null,
        status: 'reading',
        chapter: 0,
        volume: null,
      },
    };
  }
}

MangaDexAPIWrapper.serviceName = 'mangadex';

module.exports = MangaDexAPIWrapper;
