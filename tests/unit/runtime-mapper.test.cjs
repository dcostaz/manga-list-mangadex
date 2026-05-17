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
    wrapperEvidence: {
      classification: 'weak',
      matchedField: 'title',
      matchedText: 'A',
      similarity: null,
      tokenOverlap: null,
      wrapperScore: null,
      algorithmVersion: 'mangadex-search-v2',
    },
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
    wrapperEvidence: {
      classification: 'fuzzy',
      matchedField: 'alternativeTitles',
      matchedText: 'TBATE',
      similarity: null,
      tokenOverlap: null,
      wrapperScore: 0.87,
      algorithmVersion: 'mangadex-search-v2',
    },
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
    genres: [],
    authors: [],
    publishers: [],
    url: 'https://mangadex.org/title/mdx-1',
    cover: null,
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
          tags: [
            { attributes: { name: { en: 'Action' } } },
            { attributes: { name: { en: 'Fantasy' } } },
          ],
        },
        relationships: [
          { type: 'author', attributes: { name: 'SIU' } },
          { type: 'artist', attributes: { name: 'Dubu' } },
        ],
      },
      metadata: {
        relationships: [{ type: 'author', id: 'author-1' }],
        publishers: [{ publisher_name: 'Naver' }],
      },
      cover: {
        coverUrl: 'https://uploads.mangadex.org/covers/777/cover-file.jpg',
        thumbnailUrl: 'https://uploads.mangadex.org/covers/777/cover-file.jpg.256.jpg',
        fileName: 'cover-file.jpg',
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
    genres: ['Action', 'Fantasy'],
    authors: [
      { name: 'SIU', type: 'Author' },
      { name: 'Dubu', type: 'Artist' },
    ],
    publishers: [{ name: 'Naver', type: 'Unknown' }],
    url: 'https://mangadex.org/title/777',
    cover: {
      trackerId: '777',
      source: 'mangadex',
      coverUrl: 'https://uploads.mangadex.org/covers/777/cover-file.jpg',
      thumbnailUrl: 'https://uploads.mangadex.org/covers/777/cover-file.jpg.256.jpg',
      fileName: 'cover-file.jpg',
      mimeType: null,
      width: null,
      height: null,
    },
    metadata: {
      relationships: [{ type: 'author', id: 'author-1' }],
      publishers: [{ publisher_name: 'Naver' }],
    },
  });
});

test('wave0 mapper contract - toSeriesDetailDto canonicalizes publisher role alias to Original', () => {
  const mapper = new MangaDexTrackerMapper();
  const dto = mapper.toSeriesDetailDto({
    payload: {
      id: 901,
      title: 'Alias Publisher Series',
      publishers: [
        { publisher_name: 'Naver', type: 'Publisher' },
        { publisher_name: 'Naver', type: 'Original' },
        { publisher_name: 'Line Webtoon', role: 'publisher' }
      ]
    }
  });

  assert.deepEqual(dto && dto.publishers, [
    { name: 'Naver', type: 'Original' },
    { name: 'Line Webtoon', type: 'Original' }
  ]);
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

test('wave0 mapper contract - toCoverMetadataDtos maps cover payload entries', () => {
  const mapper = new MangaDexTrackerMapper();
  assert.deepEqual(mapper.toCoverMetadataDtos({
    payload: {
      id: 777,
      cover: {
        coverUrl: 'https://uploads.mangadex.org/covers/777/cover-file.jpg',
        thumbnailUrl: 'https://uploads.mangadex.org/covers/777/cover-file.jpg.256.jpg',
        fileName: 'cover-file.jpg',
      },
    },
  }), [{
    trackerId: '777',
    source: 'mangadex',
    coverUrl: 'https://uploads.mangadex.org/covers/777/cover-file.jpg',
    thumbnailUrl: 'https://uploads.mangadex.org/covers/777/cover-file.jpg.256.jpg',
    fileName: 'cover-file.jpg',
    mimeType: null,
    width: null,
    height: null,
  }]);
});
