'use strict';

/**
 * Plugin contract version and capability constants.
 *
 * PLUGIN_CONTRACT_VERSION: increment major on any breaking PluginAPILike change.
 * The host compares MAJOR only (`PluginPackageLoader._validateCompatibility()`), so every repo
 * that carries a mirror of this constant moves together on a major — host
 * `cls/mangalist/runtime/pluginpackageloader.cjs` plus this file in each of the six plugin repos,
 * seven mirrors in total.
 *
 * 3.0.0 — the pre-register flat-tag vocabulary is deleted
 * (`docs/plans/Plan-2026Q4-pre-register-vocabulary-removal.md`). There is no synonym expansion and
 * no legacy path: a plugin declares the strings below or it does not load.
 */

const PLUGIN_CONTRACT_VERSION = '3.0.0';
const PLUGIN_SETTINGS_CONTRACT_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Capability constants — docs/plugins/host-capability-contract.md §1.1-§1.3.
//
// This is the COMPLETE catalog, and the host enforces it as closed: 2 access offers,
// 14 operation offers, 5 presentation facts = 21 strings. `_validateCapabilities()` holds exactly
// this list and rejects anything else at load, by name. Adding one means amending §1 of the
// contract first and bumping the version — never declaring a string that is not here.
// ---------------------------------------------------------------------------

// §1.1 Access offers — the way in. Exactly one applies per plugin.
const CAPABILITY_CREDENTIAL = 'credential';
const CAPABILITY_FILE_PATH  = 'file-path';

// §1.2 Operation offers — each maps to exactly one governed domain.
const CAPABILITY_SEARCH_QUERY  = 'search.query';
const CAPABILITY_SEARCH_LOOKUP = 'search.lookup';

const CAPABILITY_ENRICH       = 'enrich';
const CAPABILITY_ENRICH_COVER = 'enrich.cover';

const CAPABILITY_SYNC_PULL = 'sync.pull';
const CAPABILITY_SYNC_PUSH = 'sync.push';
const CAPABILITY_SYNC_LIST = 'sync.list';

const CAPABILITY_SUBSCRIBE_ADD    = 'subscribe.add';
const CAPABILITY_SUBSCRIBE_REMOVE = 'subscribe.remove';

// watch.entry -> queryLive(id), watch.list -> getReadingList(), watch.summary -> summarizeEntries(ids).
// `sync.list` and `watch.list` are two offers over the ONE method `getReadingList()`, separated by
// governed domain and credential side (§2's own note): sync.list is Syncing/user-side,
// watch.list is Watching/system-side. Declaring both is not redundant. Do not collapse them.
const CAPABILITY_WATCH_ENTRY   = 'watch.entry';
const CAPABILITY_WATCH_LIST    = 'watch.list';
const CAPABILITY_WATCH_SUMMARY = 'watch.summary';

const CAPABILITY_RETRIEVE_CHAPTER_LIST  = 'retrieve.chapterList';
const CAPABILITY_RETRIEVE_CHAPTER_PAGES = 'retrieve.chapterPages';

// §1.3 Presentation facts — no gate, no precondition, no domain participation.
// workspace.exists/layout/callbacks/components are declared STRUCTURALLY, by the manifest's own
// `workspace` block (§2's mapping rows say *(none)* for all four) — these constants exist so a
// plugin author can name them, not because a manifest lists them in capabilities[].
const CAPABILITY_WORKSPACE_EXISTS     = 'workspace.exists';
const CAPABILITY_WORKSPACE_LAYOUT     = 'workspace.layout';
const CAPABILITY_WORKSPACE_CALLBACKS  = 'workspace.callbacks';
const CAPABILITY_WORKSPACE_COMPONENTS = 'workspace.components';
const CAPABILITY_FILTERABLE           = 'filterable';

// ---------------------------------------------------------------------------
// FilterNotApplicableError
// Thrown by queryFilter() when no field in the filter spec matches this
// plugin's filterSchema. The host catches this class and treats the filter
// as pass-through (fail-open).
// ---------------------------------------------------------------------------

class FilterNotApplicableError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message || 'No filter spec fields match this plugin\'s filterSchema');
    this.name = 'FilterNotApplicableError';
  }
}

module.exports = {
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_SETTINGS_CONTRACT_VERSION,

  CAPABILITY_CREDENTIAL,
  CAPABILITY_FILE_PATH,

  CAPABILITY_SEARCH_QUERY,
  CAPABILITY_SEARCH_LOOKUP,

  CAPABILITY_ENRICH,
  CAPABILITY_ENRICH_COVER,

  CAPABILITY_SYNC_PULL,
  CAPABILITY_SYNC_PUSH,
  CAPABILITY_SYNC_LIST,

  CAPABILITY_SUBSCRIBE_ADD,
  CAPABILITY_SUBSCRIBE_REMOVE,

  CAPABILITY_WATCH_ENTRY,
  CAPABILITY_WATCH_LIST,
  CAPABILITY_WATCH_SUMMARY,

  CAPABILITY_RETRIEVE_CHAPTER_LIST,
  CAPABILITY_RETRIEVE_CHAPTER_PAGES,

  CAPABILITY_WORKSPACE_EXISTS,
  CAPABILITY_WORKSPACE_LAYOUT,
  CAPABILITY_WORKSPACE_CALLBACKS,
  CAPABILITY_WORKSPACE_COMPONENTS,
  CAPABILITY_FILTERABLE,

  FilterNotApplicableError,
};
