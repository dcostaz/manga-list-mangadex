'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MangaDexTrackerMapper = require(path.join(
  __dirname,
  '..',
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangadex',
  'mapper-mangadex.cjs',
));
const {
  TRACKER_DTO_CONTRACT_VERSION,
} = require(path.join(
  __dirname,
  '..',
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'trackerdtocontract.cjs',
));

test('wave0 mapper contract - mapper identity and contract version are stable', () => {
  const mapper = new MangaDexTrackerMapper({ source: 'test' });
  assert.equal(mapper.trackerId, 'mangadex');
  assert.equal(mapper.dtoContractVersion, TRACKER_DTO_CONTRACT_VERSION);
});

test('wave0 mapper contract - toSearchResultDtos maps valid compact rows and drops invalid rows', () => {
  const mapper = new MangaDexTrackerMapper();
  const dtoList = mapper.toSearchResultDtos({
    payload: {
      data: [
        { id: 'mdx-123', title: 'A' },
        { id: 'mdx-missing-title', title: null },
        { id: null, title: 'No Id' },
      ],
    },
  });

  assert.equal(dtoList.length, 1);
  assert.deepEqual(dtoList[0], {
    source: 'mangadex',
    trackerId: 'mdx-123',
    title: 'A',
    alternativeTitles: [],
    coverUrl: null,
    metadata: null,
    confidence: 100,
    matchType: 'exact',
  });
});

test('wave0 mapper contract - toSearchResultDtos accepts enriched rows with attributes fallback fields', () => {
  const mapper = new MangaDexTrackerMapper();
  const dtoList = mapper.toSearchResultDtos({
    payload: {
      data: [
        {
          id: 654,
          matchType: 'fuzzy',
          confidence: 87,
          metadata: { matchedTitle: 'TBATE' },
          coverUrl: 'https://img.example/tbate-thumb.jpg',
          attributes: {
            title: { en: 'The Beginning After the End' },
            altTitles: [{ ko: 'TBATE' }],
          },
        },
      ],
    },
  });

  assert.equal(dtoList.length, 1);
  assert.deepEqual(dtoList[0], {
    source: 'mangadex',
    trackerId: '654',
    title: 'The Beginning After the End',
    alternativeTitles: ['TBATE'],
    coverUrl: 'https://img.example/tbate-thumb.jpg',
    metadata: { matchedTitle: 'TBATE' },
    confidence: 87,
    matchType: 'fuzzy',
  });
});

test('wave0 mapper contract - toSeriesDetailDto returns null on invalid payload', () => {
  const mapper = new MangaDexTrackerMapper();
  assert.equal(mapper.toSeriesDetailDto(null), null);
  assert.equal(mapper.toSeriesDetailDto({ payload: { id: 'mdx-1' } }), null);
});

test('wave0 mapper contract - toSeriesDetailDto maps required compact fields', () => {
  const mapper = new MangaDexTrackerMapper();
  const dto = mapper.toSeriesDetailDto({
    payload: {
      id: 'mdx-1',
      title: 'Dandadan',
    },
  });

  assert.deepEqual(dto, {
    trackerId: 'mdx-1',
    source: 'mangadex',
    title: 'Dandadan',
    alternativeTitles: [],
    description: null,
    status: null,
    year: null,
    url: 'https://mangadex.org/title/mdx-1',
    metadata: null,
  });
});

test('wave0 mapper contract - toSeriesDetailDto maps enriched nested manga payload', () => {
  const mapper = new MangaDexTrackerMapper();
  const dto = mapper.toSeriesDetailDto({
    payload: {
      data: {
        id: 777,
        attributes: {
          title: { en: 'Tower of God' },
          altTitles: [{ ko: 'Sin-ui Tap' }],
          description: { en: 'A long-running webtoon.' },
          status: 'ongoing',
          year: 2010,
        },
      },
      metadata: {
        relationships: [{ type: 'author', id: 'author-1' }],
      },
    },
  });

  assert.deepEqual(dto, {
    trackerId: '777',
    source: 'mangadex',
    title: 'Tower of God',
    alternativeTitles: ['Sin-ui Tap'],
    description: 'A long-running webtoon.',
    status: 'ongoing',
    year: 2010,
    url: 'https://mangadex.org/title/777',
    metadata: {
      relationships: [{ type: 'author', id: 'author-1' }],
    },
  });
});

test('wave0 mapper contract - toStatusDto normalizes flat and nested payload status fields', () => {
  const mapper = new MangaDexTrackerMapper();

  const flat = mapper.toStatusDto({
    payload: {
      status: 'reading',
      chapter: 102,
      volume: null,
      rating: 8,
    },
  });

  assert.deepEqual(flat, {
    status: 'reading',
    chapter: 102,
    volume: null,
    rating: 8,
    lastUpdated: null,
  });

  const nested = mapper.toStatusDto({
    payload: {
      status: {
        status: 'completed',
        chapter: 120,
        volume: 12,
        rating: 9,
      },
    },
  });

  assert.deepEqual(nested, {
    status: 'completed',
    chapter: 120,
    volume: 12,
    rating: 9,
    lastUpdated: null,
  });
});

test('wave0 mapper contract - toCoverMetadataDtos returns empty collection for placeholder mapper', () => {
  const mapper = new MangaDexTrackerMapper();
  assert.deepEqual(mapper.toCoverMetadataDtos({ payload: [] }), []);
});
