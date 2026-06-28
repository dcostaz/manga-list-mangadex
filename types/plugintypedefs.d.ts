/**
 * Type definitions for manga-list plugin packages.
 *
 * Covers: PluginAPILike (all capabilities), all DTOs, cache adapter contract.
 * See Plan-2026Q3-unified-plugin-system.md §4.2–§4.3e, §4.8.
 */

// ---------------------------------------------------------------------------
// Cache adapter (§4.8 — replaces TrackerCacheAdapterLike)
// ---------------------------------------------------------------------------

export interface PluginCacheAdapterLike {
  getValue(key: string): Promise<unknown>;
  setValue(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  deleteValue?(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Generic primitives
// ---------------------------------------------------------------------------

export type PluginServiceSettings = Record<string, unknown>;

/** Stored plugin credentials — contents are plugin-specific. */
export type PluginCredential = Record<string, string>;

/** Canonical reading status identifiers used by the host. */
export type PluginReadingStatus =
  | 'READING'
  | 'COMPLETED'
  | 'PLAN_TO_READ'
  | 'ON_HOLD'
  | 'DROPPED'
  | 'RE_READING';

// ---------------------------------------------------------------------------
// Settings class contract
// ---------------------------------------------------------------------------

export interface PluginAPISettingsLike {
  componentName: string;
  toLegacyFormat(): PluginServiceSettings;
  getSetting(key: string): unknown;
}

// ---------------------------------------------------------------------------
// syncOptions types (§4.1 manifest — tracker.sync plugins)
// ---------------------------------------------------------------------------

export interface PluginSyncOptions {
  searchRequiresAuth: boolean;
  supportsStatusSync: boolean;
  supportsRatingSync: boolean;
  supportsChapterSync: boolean;
  supportsVolumeSync: boolean;
  statusVocabulary: Record<PluginReadingStatus, string | null>;
}

// ---------------------------------------------------------------------------
// Core lifecycle types
// ---------------------------------------------------------------------------

export interface PluginInitResult {
  status: 'ok' | 'error';
  message?: string;
}

export interface PluginStatus {
  status: 'ok' | 'error' | 'initializing';
  message?: string;
}

// ---------------------------------------------------------------------------
// PluginAPILike — base interface (§4.2)
// ---------------------------------------------------------------------------

export interface PluginAPILike {
  readonly pluginName: string;
  readonly pluginType: string[];        // normalised array always
  readonly capabilities: string[];
  initialize(): Promise<PluginInitResult>;
  getStatus(): PluginStatus;
}

// ---------------------------------------------------------------------------
// tracker.search (§4.2)
// ---------------------------------------------------------------------------

export interface PluginSearchOptions {
  limit?: number;
  credential?: PluginCredential | null;
}

export interface PluginSearchResult {
  pluginEntryId: string;
  title: string;
  altTitles?: string[];
  description?: string;
  coverUrl?: string;
  authors?: string[];
  seriesStatus?: string;
  score?: number;
}

// ---------------------------------------------------------------------------
// tracker.sync (§4.2)
// ---------------------------------------------------------------------------

export interface PluginProgressDTO {
  readingStatus?: string | null;
  chapter?: number | null;
  volume?: number | null;
  rating?: number | null;
  lastUpdated?: string | null;
}

export interface PluginSubscribeContext {
  readingStatus: string;   // local status name e.g. 'READING'
  chapter?: number;
  rating?: number;
}

// ---------------------------------------------------------------------------
// tracker.cover (§4.2)
// ---------------------------------------------------------------------------

export interface PluginCoverSearchOptions {
  limit?: number;
  credential?: PluginCredential | null;
}

export interface PluginCoverResult {
  coverId: string;
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  volumeNumber?: number;
}

// ---------------------------------------------------------------------------
// adapter.enrich (§4.2)
// ---------------------------------------------------------------------------

export interface PluginMatchOptions {
  limit?: number;
}

export interface PluginMatchCandidate {
  pluginEntryId: string;
  title: string;
  altTitles?: string[];
  confidence: number;
}

// ---------------------------------------------------------------------------
// PluginLinkContribution (§4.3a)
// ---------------------------------------------------------------------------

export interface PluginSourceLink {
  siteId: string;
  siteLabel: string;
  seriesUrl: string;
  isPrimary: boolean;
}

export interface PluginLinkContribution {
  pluginEntryId: string;
  displayTitle?: string;
  altTitles?: string[];
  authors?: string[];
  artists?: string[];
  description?: string;
  coverUrl?: string;
  seriesStatus?: 'ongoing' | 'completed' | 'hiatus' | 'unknown';
  genres?: string[];
  tags?: string[];
  sourceLinks?: PluginSourceLink[];
  syncedAt: string;             // ISO timestamp → plugin_references.last_synced
  syncIntervalHint?: number;    // seconds; host may ignore
}

// ---------------------------------------------------------------------------
// adapter.import / adapter.discover (§4.2)
// ---------------------------------------------------------------------------

export interface PluginImportOptions {
  credential?: PluginCredential | null;
  [key: string]: unknown;
}

export interface PluginImportResult {
  importedCount: number;
  skippedCount?: number;
  errors?: string[];
}

export interface PluginDiscoveryOptions {
  limit?: number;
  credential?: PluginCredential | null;
}

export interface PluginDiscoveryResult {
  pluginEntryId: string;
  title: string;
  altTitles?: string[];
  coverUrl?: string;
}

// ---------------------------------------------------------------------------
// workspace.list + workspace.get (§4.2)
// ---------------------------------------------------------------------------

/** All workspace.list plugins MUST apply includeIds/excludeIds server-side before pagination. */
export interface PluginEntryFilters {
  search?: string;
  includeIds?: string[];    // restrict results to these plugin_entry_ids
  excludeIds?: string[];    // omit these plugin_entry_ids from results
}

export interface Pagination {
  page: number;
  pageSize: number;
}

export interface PluginEntryPage {
  entries: PluginWorkspaceEntry[];
  totalCount: number;   // MUST reflect filtered count, not unfiltered total
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// PluginWorkspaceEntry + field type vocabulary (§4.2a)
// ---------------------------------------------------------------------------

export type PluginFieldType =
  | 'text'       // plain string
  | 'number'     // numeric value; rendered as a stat figure
  | 'status'     // string; rendered as a colored chip
  | 'date'       // ISO date string; formatted for locale display
  | 'url'        // string URL; rendered as a hyperlink
  | 'image'      // string URL; rendered as an image resource
  | 'progress'   // number 0–1; rendered as a progress bar
  | 'alt-names'  // string[]; collapsible list; first value used as card subtitle strip
  | 'item-list'; // PluginWorkspaceItem[]; rendered as a row list

export interface PluginWorkspaceItem {
  id: string;
  label: string;
  value?: string;
  url?: string;
}

export interface PluginWorkspaceField {
  type: PluginFieldType;
  value: unknown;      // must match the declared type
  label?: string;      // overrides default display label for this field
}

export interface PluginWorkspaceEntry {
  pluginEntryId: string;
  fields: Record<string, PluginWorkspaceField>;
}

// ---------------------------------------------------------------------------
// DetailLayoutSection types (§4.2a — manifest-declared workspace detail panel)
// ---------------------------------------------------------------------------

export type DetailLayoutSectionType = 'stat-grid' | 'item-list' | 'live-embed';

export interface StatGridSection {
  sectionId: string;
  type: 'stat-grid';
  label: string;
  fields: string[];    // field names resolved from PluginWorkspaceEntry.fields
}

export interface ItemListSection {
  sectionId: string;
  type: 'item-list';
  label: string;
  itemsField: string;
  actions?: Array<{ actionId: string; icon: string; label: string }>;
}

export interface LiveEmbedSection {
  sectionId: string;
  type: 'live-embed';
  label: string;
  // Only valid when plugin also declares plugin.live; loader rejects otherwise.
}

export type DetailLayoutSection = StatGridSection | ItemListSection | LiveEmbedSection;

// ---------------------------------------------------------------------------
// PluginLiveData + section types (§4.3b)
// ---------------------------------------------------------------------------

export type PluginLiveSectionType =
  | 'stat-grid'
  | 'progress'
  | 'item-list'
  | 'link-list'
  | 'text'
  | 'action-list';

export interface PluginLiveStatGridSection {
  type: 'stat-grid';
  label?: string;
  fields: Array<{ label: string; value: string | number }>;
}

export interface PluginLiveProgressSection {
  type: 'progress';
  label?: string;
  value: number;
  max?: number;
}

export interface PluginLiveItemListSection {
  type: 'item-list';
  label?: string;
  items: Array<{ id: string; label: string; value?: string; url?: string }>;
}

export interface PluginLiveLinkListSection {
  type: 'link-list';
  label?: string;
  links: Array<{ label: string; url: string }>;
}

export interface PluginLiveTextSection {
  type: 'text';
  label?: string;
  content: string;
}

export interface PluginLiveActionListSection {
  type: 'action-list';
  label?: string;
  actions: PluginContextAction[];
}

export type PluginLiveSection =
  | PluginLiveStatGridSection
  | PluginLiveProgressSection
  | PluginLiveItemListSection
  | PluginLiveLinkListSection
  | PluginLiveTextSection
  | PluginLiveActionListSection;

export interface PluginLiveData {
  pluginEntryId: string;
  displayTitle?: string;
  linkState: 'linked' | 'active' | 'error' | 'offline';
  statusLabel?: string;
  fetchedAt: string;
  sections: PluginLiveSection[];
}

/** Discriminated union returned by queryLive(). */
export type PluginLiveQueryResult =
  | { status: 'ok';      data: PluginLiveData }
  | { status: 'offline'; message?: string }
  | { status: 'not_found' }
  | { status: 'error';   message: string; retryable: boolean };

// ---------------------------------------------------------------------------
// PluginContextAction + PluginActionResult (§4.3c)
// ---------------------------------------------------------------------------

export interface PluginContextAction {
  actionId: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export type PluginActionResult =
  | { status: 'ok';      message?: string }
  | { status: 'pending'; message?: string }
  | { status: 'error';   message: string; retryable: boolean };

// ---------------------------------------------------------------------------
// PluginCardSummary (§4.3d)
// ---------------------------------------------------------------------------

export interface PluginCardSummary {
  linkState: 'linked' | 'active' | 'error' | 'offline';
  label?: string;
  contextActions?: PluginContextAction[];
}

// ---------------------------------------------------------------------------
// PluginFilterSpec (§4.3e)
// ---------------------------------------------------------------------------

export interface PluginFilterSpec {
  presetId?: string;
  fields?: Record<string, unknown>;
  candidateUuids?: string[];   // hint: UUIDs already passing SQL filter
}

// ---------------------------------------------------------------------------
// LocalTrackerEntry (passed to syncEnrichment)
// ---------------------------------------------------------------------------

export interface LocalTrackerEntry {
  id: number;
  uuid: string;
  title: string;
  altTitles?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Plugin module descriptor (exported by plugin-module.cjs)
// ---------------------------------------------------------------------------

export interface PluginModuleDescriptor {
  WrapperClass: Function;
  SettingsClass: Function;
}

// ---------------------------------------------------------------------------
// API wrapper init options (referenced in plugincontexttypedefs.d.ts)
// ---------------------------------------------------------------------------

export interface PluginAPIWrapperInitOptions {
  context: import('./plugincontexttypedefs').PluginContextLike;
  apiSettings?: PluginAPISettingsLike | null;
  serviceSettings?: PluginServiceSettings | null;
}
