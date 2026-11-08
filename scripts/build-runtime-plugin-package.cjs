#!/usr/bin/env node
'use strict';

/**
 * Builds a tracker's runtime package zip, the same way for every tracker built from the template
 * (Plan-2026Q4-tracker-plugin-standardization, Phase 3). Nothing here names the plugin: it finds the one
 * `src/runtime/apiwrappers/reg-<id>/plugin-package.json` of type `tracker` and derives the rest from its
 * `pluginName`:
 *
 *   apiwrappers/reg-<id>/plugin-<id>.cjs, client-<id>.cjs, mapping-<id>.cjs   the three layers
 *   apiwrappers/reg-<id>/plugin-package.json and plugin-package.json           the manifest (beside the module, and at the root the loader reads)
 *   apiwrappers/reg-<id>/<id>-api-settings.json                                <id>-api-settings.definition.json + .values.json, merged
 *   the manifest's iconPath and images/, when present
 *
 * The plugin SDK is NOT bundled: the host places it beside the runtime root, where `require('@manga-list/plugin-sdk')`
 * resolves (contract §1.4). The manifest's pluginContractVersion is checked against the SDK the build runs with.
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const pkg = require('../package.json');
const { PLUGIN_CONTRACT_VERSION, PLUGIN_SETTINGS_CONTRACT_VERSION } = require('@manga-list/plugin-sdk');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const APIWRAPPERS_DIR = path.join(ROOT_DIR, 'src', 'runtime', 'apiwrappers');

/** @param {string} fullPath @param {string} label @returns {Record<string, any>} */
function readJsonObject(fullPath, label) {
  if (!fs.existsSync(fullPath)) throw new Error(`Missing ${label}: ${fullPath}`);
  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Expected ${label} to be an object: ${fullPath}`);
  return parsed;
}

/** The one tracker under src/runtime/apiwrappers. @returns {{ id: string, dir: string, manifest: Record<string, any> }} */
function locateTracker() {
  const found = fs.readdirSync(APIWRAPPERS_DIR)
    .filter((name) => name.startsWith('reg-'))
    .map((name) => path.join(APIWRAPPERS_DIR, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'plugin-package.json')))
    .map((dir) => ({ dir, manifest: readJsonObject(path.join(dir, 'plugin-package.json'), 'plugin-package.json') }))
    .filter(({ manifest }) => manifest.pluginType === 'tracker');
  if (found.length !== 1) {
    throw new Error(`Expected exactly one tracker manifest under ${APIWRAPPERS_DIR}, found ${found.length}`);
  }
  const { dir, manifest } = found[0];
  const id = String(manifest.pluginName || '');
  if (!id || path.basename(dir) !== `reg-${id}`) {
    throw new Error(`The tracker's folder must be reg-<pluginName> (folder '${path.basename(dir)}', pluginName '${id}')`);
  }
  return { id, dir, manifest };
}

/** @param {Record<string, any>} source @param {string} hostApiVersion */
function buildManifest(source, hostApiVersion) {
  const declared = typeof source.pluginContractVersion === 'string' ? source.pluginContractVersion.trim() : '';
  if (!declared) throw new Error('plugin-package.json must include pluginContractVersion');
  if (declared.split('.')[0] !== PLUGIN_CONTRACT_VERSION.split('.')[0]) {
    throw new Error(`plugin-package.json pluginContractVersion ${declared} is not the SDK's major (${PLUGIN_CONTRACT_VERSION})`);
  }
  return { ...source, hostApiVersion, pluginContractVersion: declared };
}

/** @param {string} dir @param {string} id */
function buildEffectiveSettingsDocument(dir, id) {
  const definition = readJsonObject(path.join(dir, `${id}-api-settings.definition.json`), 'settings definition');
  const values = readJsonObject(path.join(dir, `${id}-api-settings.values.json`), 'settings values');
  for (const [label, doc] of /** @type {Array<[string, Record<string, any>]>} */ ([['definition', definition], ['values', values]])) {
    const version = doc.metadata && doc.metadata.settingsContractVersion;
    if (version !== PLUGIN_SETTINGS_CONTRACT_VERSION) {
      throw new Error(`settings ${label} metadata.settingsContractVersion must be ${PLUGIN_SETTINGS_CONTRACT_VERSION}, got '${version}'`);
    }
  }
  const schema = definition.schema || {};
  /** @type {Record<string, unknown>} */
  const settings = {};
  for (const [key, entry] of Object.entries(schema)) {
    if (Object.prototype.hasOwnProperty.call(values.settings || {}, key)) settings[key] = values.settings[key];
    else if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'default')) settings[key] = entry.default;
  }
  return { metadata: { ...definition.metadata }, schema: { ...schema }, settings };
}

/**
 * The package's file list: [source path, path in the zip].
 * @param {{ id: string, dir: string, manifest: Record<string, any> }} tracker
 * @returns {Array<[string, string]>}
 */
function packageFiles({ id, dir, manifest }) {
  const reg = `apiwrappers/reg-${id}`;
  /** @type {Array<[string, string]>} */
  const files = ['plugin', 'client', 'mapping'].map((layer) => [path.join(dir, `${layer}-${id}.cjs`), `${reg}/${layer}-${id}.cjs`]);
  for (const [src] of files) if (!fs.existsSync(src)) throw new Error(`Missing ${src}`);
  if (typeof manifest.iconPath === 'string' && manifest.iconPath) {
    files.push([path.join(dir, manifest.iconPath), manifest.iconPath]);
  }
  const images = path.join(dir, 'images');
  if (fs.existsSync(images)) {
    for (const name of fs.readdirSync(images)) files.push([path.join(images, name), `images/${name}`]);
  }
  // The icon is usually also in images/: one entry per path in the zip.
  return [...new Map(files.map((entry) => [entry[1], entry])).values()];
}

/**
 * @param {{ outputPath?: string | null, hostApiVersion?: string | null }} [options]
 * @returns {Promise<{ outputPath: string, entries: string[] }>}
 */
async function buildRuntimePluginPackage(options = {}) {
  const tracker = locateTracker();
  const hostApiVersion = String(options.hostApiVersion || process.env.MANGALIST_HOST_API_VERSION || '1.0.0').trim() || '1.0.0';
  const outputPath = options.outputPath ? path.resolve(options.outputPath) : path.join(DIST_DIR, `${pkg.name}-runtime-${pkg.version}.zip`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const manifestText = JSON.stringify(buildManifest(tracker.manifest, hostApiVersion), null, 2);
  const settingsText = JSON.stringify(buildEffectiveSettingsDocument(tracker.dir, tracker.id), null, 2);
  const reg = `apiwrappers/reg-${tracker.id}`;
  const files = packageFiles(tracker);
  /** @type {string[]} */
  const entries = [...files.map(([, dest]) => dest), 'plugin-package.json', `${reg}/plugin-package.json`, `${reg}/${tracker.id}-api-settings.json`];

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(undefined));
    archive.on('error', reject);
    archive.pipe(output);
    for (const [src, dest] of files) archive.file(src, { name: dest });
    archive.append(manifestText, { name: 'plugin-package.json' });
    archive.append(manifestText, { name: `${reg}/plugin-package.json` });
    archive.append(settingsText, { name: `${reg}/${tracker.id}-api-settings.json` });
    archive.finalize();
  });
  return { outputPath, entries };
}

module.exports = { locateTracker, buildManifest, buildEffectiveSettingsDocument, buildRuntimePluginPackage };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (/** @type {string} */ name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  buildRuntimePluginPackage({ outputPath: flag('--output'), hostApiVersion: flag('--host-api-version') })
    .then(({ outputPath, entries }) => {
      console.log(`Runtime plugin package built: ${outputPath}`);
      for (const entry of entries) console.log(`  ${entry}`);
    })
    .catch((error) => {
      console.error('Build failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
