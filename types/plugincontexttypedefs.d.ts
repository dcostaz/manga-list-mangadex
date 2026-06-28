/**
 * Host-injected context passed to every plugin's init() factory.
 *
 * This file is the single extension point for all future host-provided utilities
 * (logger, feature flags, etc.). Adding a new field is non-breaking (minor bump).
 * Removing or changing an existing field is breaking (major bump).
 *
 * See Plan-2026Q3-unified-plugin-system.md §4a (Step 4a).
 */

import type { PluginCacheAdapterLike, PluginAPISettingsLike, PluginServiceSettings } from './plugintypedefs';

/** Utility functions provided by the host to every plugin. */
export interface PluginContextUtils {
  /**
   * Normalises a string for search comparison: NFKD Unicode normalisation,
   * removes filesystem-unsafe characters, collapses whitespace, lowercases,
   * strips leading/trailing spaces.
   * Returns empty string for non-string input.
   */
  sanitizeForSearch(text: string): string;
}

/**
 * Host-injected context passed to every plugin's init() factory.
 * The host constructs this object; plugins store a reference to it.
 * Access as this._context in all plugin methods.
 */
export interface PluginContextLike {
  utils: PluginContextUtils;
  /** null when TieredCache is disabled (see §4.8). All plugin cache calls must guard for null. */
  cache: PluginCacheAdapterLike | null;
}

/**
 * Options passed to the static init() factory of every plugin wrapper class.
 * Replaces TrackerAPIWrapperInitOptions; onCredentialsRequired is removed
 * (PluginCredentialBroker owns credentials; cacheAdapter is injected via context.cache).
 */
export interface PluginAPIWrapperInitOptions {
  context: PluginContextLike;
  apiSettings?: PluginAPISettingsLike | null;
  serviceSettings?: PluginServiceSettings | null;
}
