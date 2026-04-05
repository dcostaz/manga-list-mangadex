'use strict';

class MangaDexAPISettings {
  /**
   * @param {Record<string, unknown>} [settings]
   */
  constructor(settings = {}) {
    this._settings = settings;
  }

  /**
   * @param {object} [options]
   * @param {Record<string, unknown>} [options.defaultSettings]
   * @returns {Promise<MangaDexAPISettings>}
   */
  static async init(options = {}) {
    const defaults = options && typeof options === 'object' ? options.defaultSettings : null;
    return new MangaDexAPISettings(defaults && typeof defaults === 'object' ? defaults : {});
  }

  /**
   * @returns {Record<string, unknown>}
   */
  toLegacyFormat() {
    return { ...this._settings };
  }
}

module.exports = MangaDexAPISettings;
