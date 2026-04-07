'use strict';

const path = require('path');
const { TRACKER_DTO_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'trackerdtocontract.cjs'));

/** @typedef {import('../../../../types/trackertypedefs').MangaDexRawSearchResponse} MangaDexRawSearchResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexRawEntityResponse} MangaDexRawEntityResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexSeriesDetailDto} MangaDexSeriesDetailDto */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexStatusDto} MangaDexStatusDto */

class MangaDexTrackerMapper {
  /**
   * @param {Record<string, unknown> | null} [initContext]
   */
  constructor(initContext = null) {
    this.trackerId = 'mangadex';
    this.dtoContractVersion = TRACKER_DTO_CONTRACT_VERSION;
    this.initContext = initContext;
  }

  /**
    * @param {MangaDexRawSearchResponse | null} raw
   * @returns {Array<Record<string, unknown>>}
   */
  toSearchResultDtos(raw) {
    const payload = raw && typeof raw === 'object' ? raw.payload : null;
    const rows = payload && Array.isArray(payload.data) ? payload.data : [];

    return rows
      .map((row) => {
        const trackerId = typeof row.id === 'string' ? row.id : null;
        const title = typeof row.title === 'string' ? row.title : null;
        if (!trackerId || !title) {
          return null;
        }

        return {
          source: this.trackerId,
          trackerId,
          title,
          alternativeTitles: [],
          coverUrl: null,
          metadata: null,
          confidence: 0,
          matchType: 'exact',
        };
      })
      .filter((entry) => entry !== null);
  }

  /**
    * @param {MangaDexRawEntityResponse | null} raw
    * @returns {MangaDexSeriesDetailDto | null}
   */
  toSeriesDetailDto(raw) {
    const payload = raw && typeof raw === 'object' ? raw.payload : null;
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const trackerId = typeof payload.id === 'string' ? payload.id : null;
    const title = typeof payload.title === 'string' ? payload.title : null;
    if (!trackerId || !title) {
      return null;
    }

    return {
      trackerId,
      source: this.trackerId,
      title,
      alternativeTitles: [],
      description: null,
      status: null,
      year: null,
      url: null,
      metadata: null,
    };
  }

  /**
    * @param {MangaDexRawEntityResponse | null} raw
    * @returns {MangaDexStatusDto | null}
   */
  toStatusDto(raw) {
    const payload = raw && typeof raw === 'object' ? raw.payload : null;
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    return {
      status: typeof payload.status === 'string' ? payload.status : undefined,
      chapter: typeof payload.chapter === 'number' ? payload.chapter : null,
      volume: typeof payload.volume === 'number' ? payload.volume : null,
      rating: typeof payload.rating === 'number' ? payload.rating : null,
      lastUpdated: null,
    };
  }

  /**
   * @param {unknown} _raw
   * @returns {Array<Record<string, unknown>>}
   */
  toCoverMetadataDtos(_raw) {
    return [];
  }
}

module.exports = MangaDexTrackerMapper;
