'use strict';

const path = require('path');
const { TRACKER_DTO_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'trackerdtocontract.cjs'));

/** @typedef {import('../../../../types/trackertypedefs').MangaDexRawSearchResponse} MangaDexRawSearchResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexRawEntityResponse} MangaDexRawEntityResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexSeriesDetailDto} MangaDexSeriesDetailDto */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexStatusDto} MangaDexStatusDto */
/** @typedef {import('../../../../types/trackertypedefs').MangaDexCoverMetadataDto} MangaDexCoverMetadataDto */

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
          : [];
        const attributeTitleVariants = attributes && attributes.title && typeof attributes.title === 'object'
          ? Object.values(attributes.title)
          : [];

        const alternativeTitles = this._normalizeAlternativeTitles([
          rowAlternativeTitles,
          attributeAlternativeTitles,
          attributeTitleVariants,
        ], title);
        const rowMetadata = row && row.metadata && typeof row.metadata === 'object'
          ? row.metadata
          : null;
        const wrapperEvidence = this._buildWrapperEvidence(row, rowMetadata, title, alternativeTitles);

        const coverUrl = row && typeof row.coverUrl === 'string'
          ? row.coverUrl
          : null;

        return {
          source: this.trackerId,
          trackerId,
          title,
          alternativeTitles,
          coverUrl,
          metadata: rowMetadata,
          wrapperEvidence,
        };
      })
      .filter((entry) => entry !== null);
  }

  /**
   * @param {Record<string, unknown>} row
   * @param {Record<string, unknown> | null} rowMetadata
   * @param {string} title
   * @param {string[]} alternativeTitles
   * @returns {Record<string, unknown>}
   */
  _buildWrapperEvidence(row, rowMetadata, title, alternativeTitles) {
    const rawMatchType = typeof row.matchType === 'string' ? row.matchType.trim().toLowerCase() : '';
    const rawMatchedTitle = this._normalizeString(
      row.hit_title,
      row.matchedTitle,
      rowMetadata && rowMetadata.matchedTitle,
      title
    );
    const normalizedTitle = typeof title === 'string' ? title.trim().toLowerCase() : '';
    const normalizedMatchedTitle = typeof rawMatchedTitle === 'string' ? rawMatchedTitle.trim().toLowerCase() : '';

    let classification = 'weak';
    if (rawMatchType === 'exact') {
      classification = 'exact';
      const hasAliasExact = Boolean(
        normalizedMatchedTitle
        && normalizedTitle
        && normalizedMatchedTitle !== normalizedTitle
        && alternativeTitles.some((entry) => typeof entry === 'string' && entry.trim().toLowerCase() === normalizedMatchedTitle)
      );
      if (hasAliasExact) {
        classification = 'alias-exact';
      }
    } else if (rawMatchType === 'fuzzy') {
      classification = 'fuzzy';
    }

    const rawMatchedField = this._normalizeString(
      row.matchedField,
      rowMetadata && rowMetadata.matchedField
    );
    const matchedField = rawMatchedField === 'title'
      ? 'title'
      : rawMatchedField === 'alternativeTitles'
        ? 'alternativeTitles'
        : rawMatchedField === 'metadata'
          ? 'metadata'
          : normalizedMatchedTitle && normalizedMatchedTitle !== normalizedTitle
            ? 'alternativeTitles'
            : 'title';

    const similarity = this._normalizeUnitInterval(
      row.similarity,
      rowMetadata && rowMetadata.similarity
    );
    const tokenOverlap = this._normalizeUnitInterval(
      row.tokenOverlap,
      rowMetadata && rowMetadata.tokenOverlap
    );
    const wrapperScore = this._normalizeUnitInterval(
      row.wrapperScore,
      rowMetadata && rowMetadata.wrapperScore,
      row.confidence,
      rowMetadata && rowMetadata.confidence
    );

    return {
      classification,
      matchedField,
      matchedText: rawMatchedTitle,
      similarity,
      tokenOverlap,
      wrapperScore,
      algorithmVersion: 'mangadex-search-v2',
    };
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
      : [];
    const payloadTitleVariants = payloadAttributes && payloadAttributes.title && typeof payloadAttributes.title === 'object'
      ? Object.values(payloadAttributes.title)
      : [];

    const alternativeTitles = this._normalizeAlternativeTitles([
      payloadAlternativeTitles,
      attributeAlternativeTitles,
      payloadTitleVariants,
    ], title);

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

    const normalizedGenres = this._normalizeMetadataStringArray(
      [
        payload.genres,
        payloadAttributes && payloadAttributes.tags,
        payload.metadata && typeof payload.metadata === 'object' ? payload.metadata.genres : null,
      ],
      ['genre', 'name', 'label', 'title', 'value']
    );
    const payloadMetadata = payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : null;

    const relationshipContributors = this._extractMangaDexRelationshipContributors([
      payloadData && payloadData.relationships,
      payloadMetadata && payloadMetadata.relationships,
    ]);

    const normalizedAuthors = this._normalizeContributorEntries(
      [
        payload.authors,
        payloadMetadata && payloadMetadata.authors,
        relationshipContributors,
      ],
      ['name', 'author', 'fullName', 'label', 'title'],
      'Unknown'
    );
    const normalizedPublishers = this._normalizeContributorEntries(
      [
        payload.publishers,
        payloadMetadata && payloadMetadata.publishers,
      ],
      ['publisher_name', 'publisherName', 'name', 'publisher', 'label', 'title'],
      'Unknown'
    );

    const url = typeof payload.url === 'string'
      ? payload.url
      : `https://mangadex.org/title/${trackerId}`;

    const cover = this._buildCoverMetadataDto(trackerId, payload && typeof payload.cover === 'object' ? payload.cover : null, payload);

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
      genres: normalizedGenres,
      authors: normalizedAuthors,
      publishers: normalizedPublishers,
      url,
      cover,
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
   * @param {MangaDexRawEntityResponse | null} raw
   * @returns {MangaDexCoverMetadataDto[]}
   */
  toCoverMetadataDtos(raw) {
    const payload = raw && typeof raw === 'object' ? raw.payload : null;
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const payloadData = payload.data && typeof payload.data === 'object'
      ? payload.data
      : null;
    const trackerId = typeof payload.id === 'string' || typeof payload.id === 'number'
      ? String(payload.id)
      : typeof payload.trackerId === 'string' || typeof payload.trackerId === 'number'
        ? String(payload.trackerId)
        : payloadData && (typeof payloadData.id === 'string' || typeof payloadData.id === 'number')
          ? String(payloadData.id)
          : null;

    if (!trackerId) {
      return [];
    }

    /** @type {MangaDexCoverMetadataDto[]} */
    const result = [];
    const coverCandidates = Array.isArray(payload.covers)
      ? payload.covers
      : [];

    const primary = this._buildCoverMetadataDto(trackerId, payload && typeof payload.cover === 'object' ? payload.cover : null, payload);
    if (primary) {
      result.push(primary);
    }

    for (const candidate of coverCandidates) {
      const normalized = this._buildCoverMetadataDto(trackerId, candidate && typeof candidate === 'object' ? candidate : null, payload);
      if (!normalized) {
        continue;
      }

      if (result.some((entry) => entry.coverUrl === normalized.coverUrl && entry.thumbnailUrl === normalized.thumbnailUrl)) {
        continue;
      }

      result.push(normalized);
    }

    return result;
  }

  /**
   * @param {string} trackerId
   * @param {Record<string, unknown> | null} coverCandidate
   * @param {Record<string, unknown>} payload
   * @returns {MangaDexCoverMetadataDto | null}
   */
  _buildCoverMetadataDto(trackerId, coverCandidate, payload) {
    const coverRecord = coverCandidate && typeof coverCandidate === 'object'
      ? coverCandidate
      : null;

    const coverUrl = this._normalizeString(
      coverRecord && coverRecord.coverUrl,
      coverRecord && coverRecord.url,
      coverRecord && coverRecord.original,
      payload.coverUrl,
    );
    const thumbnailUrl = this._normalizeString(
      coverRecord && coverRecord.thumbnailUrl,
      coverRecord && coverRecord.thumb,
      payload.thumbnailUrl,
      coverRecord && coverRecord.coverUrl,
      coverRecord && coverRecord.url,
    );

    if (!coverUrl && !thumbnailUrl) {
      return null;
    }

    return {
      trackerId,
      source: this.trackerId,
      coverUrl: coverUrl || null,
      thumbnailUrl: thumbnailUrl || null,
      fileName: this._normalizeString(coverRecord && coverRecord.fileName) || null,
      mimeType: this._normalizeString(coverRecord && coverRecord.mimeType) || null,
      width: this._normalizeNumber(coverRecord && coverRecord.width),
      height: this._normalizeNumber(coverRecord && coverRecord.height),
    };
  }

  /**
    * @param {...unknown} values
   * @returns {string | null}
   */
  _normalizeString(...values) {
    for (const value of values) {
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  /**
    * @param {...unknown} values
   * @returns {number | null}
   */
  _normalizeNumber(...values) {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }

      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }

    return null;
  }

  /**
   * @param {...unknown} values
   * @returns {number | null}
   */
  _normalizeUnitInterval(...values) {
    for (const value of values) {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        continue;
      }

      const normalized = value > 1 ? value / 100 : value;
      if (normalized < 0 || normalized > 1) {
        continue;
      }

      return normalized;
    }

    return null;
  }

  /**
   * @param {unknown[]} candidates
   * @returns {string[]}
   */
  _normalizeAlternativeTitles(candidates, primaryTitle = null) {
    /** @type {string[]} */
    const values = [];
    const normalizedPrimary = typeof primaryTitle === 'string' && primaryTitle.trim()
      ? primaryTitle.trim().toLocaleLowerCase()
      : null;

    for (const candidate of candidates) {
      this._collectStringValues(candidate, values, new Set());
    }

    return Array.from(new Set(values))
      .filter((entry) => {
        if (!normalizedPrimary) {
          return true;
        }
        return entry.toLocaleLowerCase() !== normalizedPrimary;
      });
  }

  /**
   * @param {unknown[]} candidates
   * @param {string[]} preferredKeys
   * @returns {string[]}
   */
  _normalizeMetadataStringArray(candidates, preferredKeys) {
    /** @type {string[]} */
    const values = [];
    /** @type {Set<object>} */
    const visited = new Set();

    for (const candidate of candidates) {
      this._collectMetadataStringValues(candidate, values, visited, preferredKeys, true);
    }

    return Array.from(new Set(values));
  }

  /**
   * @param {unknown[]} values
   * @returns {Array<{ name: string, type: string }>}
   */
  _extractMangaDexRelationshipContributors(values) {
    /** @type {Array<{ name: string, type: string }>} */
    const contributors = [];

    /** @param {unknown} value */
    const collect = (value) => {
      if (Array.isArray(value)) {
        value.forEach((entry) => collect(entry));
        return;
      }

      if (!value || typeof value !== 'object') {
        return;
      }

      const record = /** @type {Record<string, unknown>} */ (value);
      const relationType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
      if (relationType !== 'author' && relationType !== 'artist') {
        return;
      }

      const attributes = record.attributes && typeof record.attributes === 'object' && !Array.isArray(record.attributes)
        ? /** @type {Record<string, unknown>} */ (record.attributes)
        : null;

      const directName = this._normalizeString(
        typeof record.name === 'string' ? record.name : null,
        attributes && typeof attributes.name === 'string' ? attributes.name : null,
        attributes && attributes.author,
        attributes && attributes.fullName,
        attributes && attributes.label,
        attributes && attributes.title,
      );
      const localizedName = this._extractLocalizedName(attributes && attributes.name)
        || this._extractLocalizedName(record.name);
      const name = directName || localizedName;

      if (!name) {
        return;
      }

      contributors.push({
        name,
        type: relationType === 'artist' ? 'Artist' : 'Author',
      });
    };

    values.forEach((entry) => collect(entry));
    return contributors;
  }

  /**
   * @param {unknown[]} candidates
   * @param {string[]} preferredKeys
   * @param {string} defaultType
   * @returns {Array<{ name: string, type: string }>}
   */
  _normalizeContributorEntries(candidates, preferredKeys, defaultType) {
    /** @type {Array<{ name: string, type: string }>} */
    const normalized = [];

    for (const candidate of candidates) {
      this._collectContributorEntry(candidate, normalized, preferredKeys, defaultType);
    }

    return normalized;
  }

  /**
   * @param {unknown} value
   * @param {Array<{ name: string, type: string }>} bucket
   * @param {string[]} preferredKeys
   * @param {string} defaultType
   * @returns {void}
   */
  _collectContributorEntry(value, bucket, preferredKeys, defaultType) {
    if (Array.isArray(value)) {
      value.forEach((entry) => this._collectContributorEntry(entry, bucket, preferredKeys, defaultType));
      return;
    }

    const isPublisherContributorList = Array.isArray(preferredKeys)
      && preferredKeys.some((key) => key === 'publisher_name' || key === 'publisherName' || key === 'publisher');

    /** @param {unknown} rawType */
    const normalizeContributorType = (rawType) => {
      if (typeof rawType !== 'string') {
        return '';
      }

      const trimmed = rawType.trim();
      if (!trimmed) {
        return '';
      }

      if (!isPublisherContributorList) {
        return trimmed;
      }

      return trimmed.toLowerCase() === 'publisher'
        ? 'Original'
        : trimmed;
    };

    /** @type {string} */
    let name = '';
    /** @type {string} */
    let type = '';

    if (typeof value === 'string') {
      name = value.trim();
    } else if (value && typeof value === 'object') {
      const record = /** @type {Record<string, unknown>} */ (value);

      for (const key of preferredKeys) {
        if (typeof record[key] === 'string' && record[key].trim()) {
          name = record[key].trim();
          break;
        }
      }

      if (!name) {
        const attributes = record.attributes;
        if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
          const attributeRecord = /** @type {Record<string, unknown>} */ (attributes);
          for (const key of preferredKeys) {
            if (typeof attributeRecord[key] === 'string' && attributeRecord[key].trim()) {
              name = attributeRecord[key].trim();
              break;
            }
          }

          if (!name) {
            const localizedName = this._extractLocalizedName(attributeRecord.name);
            if (localizedName) {
              name = localizedName;
            }
          }

          if (typeof attributeRecord.type === 'string' && attributeRecord.type.trim()) {
            type = normalizeContributorType(attributeRecord.type);
          } else if (typeof attributeRecord.role === 'string' && attributeRecord.role.trim()) {
            type = normalizeContributorType(attributeRecord.role);
          }
        }
      }

      if (!name) {
        const localizedName = this._extractLocalizedName(record.name);
        if (localizedName) {
          name = localizedName;
        }
      }

      if (typeof record.type === 'string' && record.type.trim()) {
        type = normalizeContributorType(record.type);
      } else if (typeof record.role === 'string' && record.role.trim()) {
        type = normalizeContributorType(record.role);
      }
    }

    if (!name) {
      return;
    }

    const normalizedType = type || defaultType;
    const normalizedName = name.toLowerCase();
    const existingSameNameIndex = bucket.findIndex((item) => item.name.toLowerCase() === normalizedName);

    if (normalizedType === defaultType) {
      if (existingSameNameIndex >= 0) {
        return;
      }
    } else if (existingSameNameIndex >= 0) {
      const existing = bucket[existingSameNameIndex];
      if (existing.type.toLowerCase() === normalizedType.toLowerCase()) {
        return;
      }
      if (existing.type.toLowerCase() === defaultType.toLowerCase()) {
        bucket.splice(existingSameNameIndex, 1);
      }
    }

    bucket.push({ name, type: normalizedType });
  }

  /**
   * @param {unknown} value
   * @param {string[]} bucket
   * @param {Set<object>} visited
   * @param {string[]} preferredKeys
   * @param {boolean} allowPlainString
   * @returns {void}
   */
  _collectMetadataStringValues(value, bucket, visited, preferredKeys, allowPlainString) {
    if (typeof value === 'string') {
      if (allowPlainString) {
        const normalized = value.trim();
        if (normalized) {
          bucket.push(normalized);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => this._collectMetadataStringValues(entry, bucket, visited, preferredKeys, allowPlainString));
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    const record = /** @type {Record<string, unknown>} */ (value);
    if (visited.has(record)) {
      return;
    }
    visited.add(record);

    for (const key of preferredKeys) {
      const directValue = record[key];
      if (typeof directValue === 'string' && directValue.trim()) {
        bucket.push(directValue.trim());
        return;
      }
      if (directValue && typeof directValue === 'object') {
        const beforeLength = bucket.length;
        this._collectMetadataStringValues(directValue, bucket, visited, preferredKeys, true);
        if (bucket.length > beforeLength) {
          return;
        }
      }
    }

    const attributes = record.attributes;
    if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
      const attributeRecord = /** @type {Record<string, unknown>} */ (attributes);

      for (const key of preferredKeys) {
        const attrValue = attributeRecord[key];
        if (typeof attrValue === 'string' && attrValue.trim()) {
          bucket.push(attrValue.trim());
          return;
        }
      }

      const localizedName = this._extractLocalizedName(attributeRecord.name);
      if (localizedName) {
        bucket.push(localizedName);
        return;
      }
    }

    const localizedName = this._extractLocalizedName(record.name);
    if (localizedName) {
      bucket.push(localizedName);
    }
  }

  /**
   * @param {unknown} value
   * @returns {string | null}
   */
  _extractLocalizedName(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    for (const candidate of Object.values(value)) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  /**
   * @param {unknown} value
   * @param {string[]} bucket
   * @param {Set<object>} visited
   * @returns {void}
   */
  _collectStringValues(value, bucket, visited) {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) {
        bucket.push(normalized);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => this._collectStringValues(entry, bucket, visited));
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    const record = /** @type {Record<string, unknown>} */ (value);
    if (visited.has(record)) {
      return;
    }
    visited.add(record);

    Object.values(record).forEach((entry) => this._collectStringValues(entry, bucket, visited));
  }
}

module.exports = MangaDexTrackerMapper;
