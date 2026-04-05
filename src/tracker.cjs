'use strict';

/**
 * MangaDex runtime tracker module.
 * Provides utilities for tracking manga reading progress.
 */

/**
 * Creates a tracker entry for a manga.
 * @param {object} manga - Manga data object
 * @param {string} manga.id - MangaDex manga ID
 * @param {string} manga.title - Manga title
 * @param {number} [manga.lastChapter] - Last read chapter number
 * @param {string} [manga.status] - Reading status (reading, completed, on_hold, dropped, plan_to_read)
 * @returns {object} Tracker entry
 */
function createTrackerEntry(manga) {
  return {
    id: manga.id,
    title: manga.title,
    lastChapter: manga.lastChapter || 0,
    status: manga.status || 'plan_to_read',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Updates an existing tracker entry.
 * @param {object} entry - Existing tracker entry
 * @param {object} updates - Fields to update
 * @returns {object} Updated tracker entry
 */
function updateTrackerEntry(entry, updates) {
  return {
    ...entry,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Filters manga list by reading status.
 * @param {object[]} entries - Array of tracker entries
 * @param {string} status - Status to filter by
 * @returns {object[]} Filtered entries
 */
function filterByStatus(entries, status) {
  return entries.filter((entry) => entry.status === status);
}

module.exports = { createTrackerEntry, updateTrackerEntry, filterByStatus };
