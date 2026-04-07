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
        const trackerId = row && (typeof row.id === 'string' || typeof row.id === 'number')
          ? String(row.id)
          : null;

        const attributes = row && row.attributes && typeof row.attributes === 'object'
          ? row.attributes
          : null;
        const titleFromAttributes = attributes && attributes.title && typeof attributes.title === 'object'
          ? Object.values(attributes.title).find((entry) => typeof entry === 'string' && entry.trim())
          : null;

        const title = row && typeof row.title === 'string'
          ? row.title
          : row && typeof row.hit_title === 'string'
            ? row.hit_title
            : typeof titleFromAttributes === 'string'
              ? titleFromAttributes
              : null;

        if (!trackerId || !title) {
          return null;
        }

        const rowAlternativeTitles = row && Array.isArray(row.alternativeTitles)
          ? row.alternativeTitles
          : [];
        const attributeAlternativeTitles = attributes && Array.isArray(attributes.altTitles)
          ? attributes.altTitles
            .flatMap((entry) => (entry && typeof entry === 'object' ? Object.values(entry) : []))
          : [];

        const alternativeTitles = [...rowAlternativeTitles, ...attributeAlternativeTitles]
          .filter((entry) => typeof entry === 'string' && entry.trim())
          .map((entry) => entry.trim());

        const matchType = row && typeof row.matchType === 'string' && ['exact', 'fuzzy', 'manual'].includes(row.matchType)
          ? row.matchType
          : 'exact';
        const confidence = row && typeof row.confidence === 'number'
          ? row.confidence
          : matchType === 'exact'
            ? 100
            : matchType === 'fuzzy'
              ? 80
              : 0;

        const coverUrl = row && typeof row.coverUrl === 'string'
          ? row.coverUrl
          : null;

        return {
          source: this.trackerId,
          trackerId,
          title,
          alternativeTitles,
          coverUrl,
          metadata: row && row.metadata && typeof row.metadata === 'object' ? row.metadata : null,
          confidence,
          matchType,
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

    const payloadData = payload.data && typeof payload.data === 'object'
      ? payload.data
      : null;
    const payloadAttributes = payloadData && payloadData.attributes && typeof payloadData.attributes === 'object'
      ? payloadData.attributes
      : null;

    const trackerId = typeof payload.id === 'string' || typeof payload.id === 'number'
      ? String(payload.id)
      : typeof payload.trackerId === 'string' || typeof payload.trackerId === 'number'
        ? String(payload.trackerId)
        : payloadData && (typeof payloadData.id === 'string' || typeof payloadData.id === 'number')
          ? String(payloadData.id)
          : null;

    const titleFromAttributes = payloadAttributes && payloadAttributes.title && typeof payloadAttributes.title === 'object'
      ? Object.values(payloadAttributes.title).find((entry) => typeof entry === 'string' && entry.trim())
      : null;
    const title = typeof payload.title === 'string'
      ? payload.title
      : typeof titleFromAttributes === 'string'
        ? titleFromAttributes
        : null;

    if (!trackerId || !title) {
      return null;
    }

    const payloadAlternativeTitles = Array.isArray(payload.alternativeTitles)
      ? payload.alternativeTitles
      : [];
    const attributeAlternativeTitles = payloadAttributes && Array.isArray(payloadAttributes.altTitles)
      ? payloadAttributes.altTitles
        .flatMap((entry) => (entry && typeof entry === 'object' ? Object.values(entry) : []))
      : [];

    const alternativeTitles = [...payloadAlternativeTitles, ...attributeAlternativeTitles]
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => entry.trim());

    const descriptionFromAttributes = payloadAttributes && payloadAttributes.description && typeof payloadAttributes.description === 'object'
      ? Object.values(payloadAttributes.description).find((entry) => typeof entry === 'string' && entry.trim())
      : null;
    const yearFromAttributes = payloadAttributes && typeof payloadAttributes.year === 'number'
      ? payloadAttributes.year
      : payloadAttributes && typeof payloadAttributes.year === 'string'
        ? Number(payloadAttributes.year)
        : null;
    const yearFromPayload = typeof payload.year === 'number'
      ? payload.year
      : typeof payload.year === 'string'
        ? Number(payload.year)
        : null;
    const normalizedYear = Number.isFinite(yearFromPayload) && yearFromPayload !== null
      ? yearFromPayload
      : Number.isFinite(yearFromAttributes) && yearFromAttributes !== null
        ? yearFromAttributes
        : null;

    const url = typeof payload.url === 'string'
      ? payload.url
      : `https://mangadex.org/title/${trackerId}`;

    return {
      trackerId,
      source: this.trackerId,
      title,
      alternativeTitles,
      description: typeof payload.description === 'string'
        ? payload.description
        : typeof descriptionFromAttributes === 'string'
          ? descriptionFromAttributes
          : null,
      status: typeof payload.status === 'string'
        ? payload.status
        : payloadAttributes && typeof payloadAttributes.status === 'string'
          ? payloadAttributes.status
          : null,
      year: normalizedYear,
      url,
      metadata: payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : payloadData || null,
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

    const payloadStatus = payload.status && typeof payload.status === 'object'
      ? payload.status
      : null;
    const chapter = typeof payload.chapter === 'number'
      ? payload.chapter
      : payloadStatus && typeof payloadStatus.chapter === 'number'
        ? payloadStatus.chapter
        : null;
    const volume = typeof payload.volume === 'number'
      ? payload.volume
      : payloadStatus && typeof payloadStatus.volume === 'number'
        ? payloadStatus.volume
        : null;
    const rating = typeof payload.rating === 'number'
      ? payload.rating
      : payloadStatus && typeof payloadStatus.rating === 'number'
        ? payloadStatus.rating
        : null;

    return {
      status: typeof payload.status === 'string'
        ? payload.status
        : payloadStatus && typeof payloadStatus.status === 'string'
          ? payloadStatus.status
          : undefined,
      chapter,
      volume,
      rating,
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
