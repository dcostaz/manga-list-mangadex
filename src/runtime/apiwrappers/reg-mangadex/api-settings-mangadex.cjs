'use strict';

const fs = require('fs').promises;

class MangaDexAPISettings {
  /**
   * @param {object} [params]
   * @param {Record<string, unknown>} [params.settings]
   * @param {string} [params.settingsPath]
   */
  constructor(params = {}) {
    const settings = params && typeof params === 'object' && params.settings && typeof params.settings === 'object'
      ? params.settings
      : {};

    this.componentName = 'MangaDexAPI';
    this._settings = settings;
    this._settingsPath = params && typeof params === 'object' && typeof params.settingsPath === 'string'
      ? params.settingsPath
      : '';
  }

  /**
   * @param {object} [options]
   * @param {string} [options.settingsPath]
   * @param {Record<string, unknown>} [options.defaultSettings]
   * @returns {Promise<MangaDexAPISettings>}
   */
  static async init(options = {}) {
    const settingsPath = options && typeof options === 'object' && typeof options.settingsPath === 'string'
      ? options.settingsPath
      : '';
    const defaults = options && typeof options === 'object' ? options.defaultSettings : null;

    /** @type {Record<string, unknown>} */
    let fileSettings = {};
    if (settingsPath) {
      const raw = await fs.readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Invalid MangaDex settings payload at ${settingsPath}`);
      }

      const metadata = parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? parsed.metadata
        : null;
      const schema = parsed.schema && typeof parsed.schema === 'object' && !Array.isArray(parsed.schema)
        ? parsed.schema
        : null;
      const settings = parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)
        ? parsed.settings
        : null;

      if (!metadata || !schema || !settings) {
        throw new Error(`Expected MangaDex settings payload with metadata/schema/settings sections at ${settingsPath}`);
      }

      fileSettings = parsed;
    }

    const defaultSettings = defaults && typeof defaults === 'object' ? defaults : {};
    return new MangaDexAPISettings({
      settingsPath,
      settings: {
        ...fileSettings,
        ...defaultSettings,
      },
    });
  }

  /**
   * @returns {Record<string, unknown>}
   */
  toLegacyFormat() {
    const settingsSection = this._settings
      && typeof this._settings === 'object'
      && this._settings.settings
      && typeof this._settings.settings === 'object'
      ? /** @type {Record<string, unknown>} */ (this._settings.settings)
      : this._settings;

    return { ...settingsSection };
  }
}

module.exports = MangaDexAPISettings;
