'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTrackerEntry, updateTrackerEntry, filterByStatus } = require('../src/tracker.cjs');

test('createTrackerEntry - creates entry with defaults', () => {
  const entry = createTrackerEntry({ id: 'abc123', title: 'One Piece' });
  assert.equal(entry.id, 'abc123');
  assert.equal(entry.title, 'One Piece');
  assert.equal(entry.lastChapter, 0);
  assert.equal(entry.status, 'plan_to_read');
  assert.ok(entry.updatedAt);
});

test('createTrackerEntry - creates entry with provided values', () => {
  const entry = createTrackerEntry({
    id: 'xyz789',
    title: 'Naruto',
    lastChapter: 50,
    status: 'completed',
  });
  assert.equal(entry.lastChapter, 50);
  assert.equal(entry.status, 'completed');
});

test('updateTrackerEntry - updates fields and refreshes updatedAt', () => {
  const entry = createTrackerEntry({ id: 'abc', title: 'Test' });
  const updated = updateTrackerEntry(entry, { lastChapter: 10, status: 'reading' });
  assert.equal(updated.id, 'abc');
  assert.equal(updated.lastChapter, 10);
  assert.equal(updated.status, 'reading');
});

test('filterByStatus - filters entries by status', () => {
  const entries = [
    createTrackerEntry({ id: '1', title: 'A', status: 'reading' }),
    createTrackerEntry({ id: '2', title: 'B', status: 'completed' }),
    createTrackerEntry({ id: '3', title: 'C', status: 'reading' }),
  ];
  const reading = filterByStatus(entries, 'reading');
  assert.equal(reading.length, 2);
  assert.ok(reading.every((e) => e.status === 'reading'));
});
