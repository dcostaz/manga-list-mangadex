#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const pkg = require('../package.json');
const {
  TRACKER_DTO_CONTRACT_VERSION,
  TRACKER_SETTINGS_CONTRACT_VERSION,
} = require(path.join(__dirname, '..', 'src', 'runtime', 'apiwrappers', 'trackerdtocontract.cjs'));

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SETTINGS_DEFINITION_SOURCE = path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'mangadex-api-settings.definition.json');
const SETTINGS_VALUES_SOURCE = path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'mangadex-api-settings.values.json');
const SETTINGS_EFFECTIVE_DEST = path.join('apiwrappers', 'reg-mangadex', 'mangadex-api-settings.json').replace(/\\/g, '/');

/** @typedef {{ src: string, dest: string }} RuntimePackageFileMapping */

/** @type {RuntimePackageFileMapping[]} */
const FILE_MAPPINGS = [
  {
    src: path.join('src', 'runtime', 'apiwrappers', 'trackerdtocontract.cjs'),
    dest: path.join('apiwrappers', 'trackerdtocontract.cjs').replace(/\\/g, '/'),
  },
  {
    src: path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'api-wrapper-mangadex.cjs'),
    dest: path.join('apiwrappers', 'reg-mangadex', 'api-wrapper-mangadex.cjs').replace(/\\/g, '/'),
  },
  {
    src: path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'api-settings-mangadex.cjs'),
    dest: path.join('apiwrappers', 'reg-mangadex', 'api-settings-mangadex.cjs').replace(/\\/g, '/'),
  },
  {
    src: path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'mapper-mangadex.cjs'),
    dest: path.join('apiwrappers', 'reg-mangadex', 'mapper-mangadex.cjs').replace(/\\/g, '/'),
  },
  {
    src: path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'tracker-module.cjs'),
    dest: path.join('apiwrappers', 'reg-mangadex', 'tracker-module.cjs').replace(/\\/g, '/'),
  },
];

/**
 * @param {string[]} argv
 * @returns {{ outputPath: string | null, hostApiVersion: string | null }}
 */
function parseCliArgs(argv) {
  let outputPath = null;
  let hostApiVersion = null;
  /** @type {string[]} */
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--output') {
      outputPath = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === '--host-api-version') {
      hostApiVersion = argv[index + 1] || null;
      index += 1;
      continue;
    }

    positional.push(token);
  }

  if (!outputPath && positional.length > 0) {
    outputPath = positional[0];
  }

  if (!hostApiVersion && positional.length > 1) {
    hostApiVersion = positional[1];
  }

  return { outputPath, hostApiVersion };
}

/**
 * @param {string | null} explicitVersion
 * @returns {string}
 */
function resolveHostApiVersion(explicitVersion) {
  const candidate = explicitVersion || process.env.MANGALIST_HOST_API_VERSION || '1.0.0';
  return String(candidate).trim() || '1.0.0';
}

/**
 * @param {string | null} explicitPath
 * @returns {string}
 */
function resolveOutputPath(explicitPath) {
  if (explicitPath && explicitPath.trim()) {
    return path.resolve(explicitPath.trim());
  }
  const fileName = `manga-list-mangadex-runtime-${pkg.version}.zip`;
  return path.join(DIST_DIR, fileName);
}

/**
 * @returns {void}
 */
function ensureDistDir() {
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }
}

/**
 * @param {string} fullPath
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function readJsonObjectFile(fullPath, label) {
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing ${label} file: ${fullPath}`);
  }

  const raw = fs.readFileSync(fullPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} file '${fullPath}': ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected ${label} file to contain an object: ${fullPath}`);
  }

  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function getObjectProperty(source, key, label) {
  const value = source[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object property '${key}' in ${label}`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Build the effective settings document used by host runtime loading.
 * Sources are split into definition and values, then merged deterministically.
 *
 * @returns {{ metadata: Record<string, unknown>, schema: Record<string, unknown>, settings: Record<string, unknown> }}
 */
function buildEffectiveSettingsDocument() {
  const definitionPath = path.join(ROOT_DIR, SETTINGS_DEFINITION_SOURCE);
  const valuesPath = path.join(ROOT_DIR, SETTINGS_VALUES_SOURCE);

  const definitionDocument = readJsonObjectFile(definitionPath, 'settings definition');
  const valuesDocument = readJsonObjectFile(valuesPath, 'settings values');

  const definitionMetadata = getObjectProperty(definitionDocument, 'metadata', 'settings definition');
  const definitionSchema = getObjectProperty(definitionDocument, 'schema', 'settings definition');
  const valuesMetadata = getObjectProperty(valuesDocument, 'metadata', 'settings values');
  const valuesSettings = getObjectProperty(valuesDocument, 'settings', 'settings values');

  const definitionContractVersion = typeof definitionMetadata.settingsContractVersion === 'string'
    ? definitionMetadata.settingsContractVersion.trim()
    : '';
  const valuesContractVersion = typeof valuesMetadata.settingsContractVersion === 'string'
    ? valuesMetadata.settingsContractVersion.trim()
    : '';

  if (!definitionContractVersion) {
    throw new Error('settings definition metadata.settingsContractVersion is required');
  }
  if (!valuesContractVersion) {
    throw new Error('settings values metadata.settingsContractVersion is required');
  }
  if (definitionContractVersion !== TRACKER_SETTINGS_CONTRACT_VERSION) {
    throw new Error(`settings definition metadata.settingsContractVersion must match TRACKER_SETTINGS_CONTRACT_VERSION (${TRACKER_SETTINGS_CONTRACT_VERSION}), got '${definitionContractVersion}'`);
  }
  if (valuesContractVersion !== TRACKER_SETTINGS_CONTRACT_VERSION) {
    throw new Error(`settings values metadata.settingsContractVersion must match TRACKER_SETTINGS_CONTRACT_VERSION (${TRACKER_SETTINGS_CONTRACT_VERSION}), got '${valuesContractVersion}'`);
  }
  if (definitionContractVersion !== valuesContractVersion) {
    throw new Error(`Settings contract version mismatch: definition=${definitionContractVersion} values=${valuesContractVersion}`);
  }

  /** @type {Record<string, unknown>} */
  const effectiveSettings = {};

  const schemaEntries = Object.entries(definitionSchema);
  for (const [settingKey, schemaEntryRaw] of schemaEntries) {
    const schemaEntry = schemaEntryRaw && typeof schemaEntryRaw === 'object' && !Array.isArray(schemaEntryRaw)
      ? /** @type {Record<string, unknown>} */ (schemaEntryRaw)
      : null;
    if (!schemaEntry) {
      throw new Error(`Invalid schema definition for key '${settingKey}'`);
    }

    const hasExplicitValue = Object.prototype.hasOwnProperty.call(valuesSettings, settingKey);
    if (hasExplicitValue) {
      effectiveSettings[settingKey] = valuesSettings[settingKey];
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(schemaEntry, 'default')) {
      effectiveSettings[settingKey] = schemaEntry.default;
      continue;
    }

    const required = schemaEntry.required === true;
    if (required) {
      throw new Error(`Missing required setting value for key '${settingKey}'`);
    }
  }

  for (const settingKey of Object.keys(valuesSettings)) {
    if (!Object.prototype.hasOwnProperty.call(definitionSchema, settingKey)) {
      throw new Error(`Values file includes undefined setting key '${settingKey}'`);
    }
  }

  return {
    metadata: {
      ...definitionMetadata,
      settingsContractVersion: TRACKER_SETTINGS_CONTRACT_VERSION,
      sources: {
        definitionFile: path.basename(SETTINGS_DEFINITION_SOURCE),
        valuesFile: path.basename(SETTINGS_VALUES_SOURCE),
      },
    },
    schema: definitionSchema,
    settings: effectiveSettings,
  };
}

/**
 * @returns {{ serviceName: string, hostApiVersion: string, dtoContractVersion: string, wrapperId: string, entrypoints: { trackerModule: string, mapperModule: string, settingsFile: string } }}
 */
function buildManifest(hostApiVersion) {
  return {
    serviceName: 'mangadex',
    hostApiVersion,
    dtoContractVersion: TRACKER_DTO_CONTRACT_VERSION,
    wrapperId: 'mangadex',
    entrypoints: {
      trackerModule: 'apiwrappers/reg-mangadex/tracker-module.cjs',
      mapperModule: 'apiwrappers/reg-mangadex/mapper-mangadex.cjs',
      settingsFile: 'apiwrappers/reg-mangadex/mangadex-api-settings.json',
    },
  };
}

/**
 * @param {{ outputPath?: string | null, hostApiVersion?: string | null }} [options]
 * @returns {Promise<{ outputPath: string, manifest: { serviceName: string, hostApiVersion: string, dtoContractVersion: string, wrapperId: string, entrypoints: { trackerModule: string, mapperModule: string, settingsFile: string } }, fileCount: number }>}
 */
function buildRuntimeTrackerPackage(options = {}) {
  ensureDistDir();

  const outputPath = resolveOutputPath(options.outputPath || null);
  const hostApiVersion = resolveHostApiVersion(options.hostApiVersion || null);
  const manifest = buildManifest(hostApiVersion);
  const effectiveSettings = buildEffectiveSettingsDocument();

  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      resolve({
        outputPath,
        manifest,
        fileCount: FILE_MAPPINGS.length + 2,
      });
    });

    archive.on('warning', (error) => {
      if (error.code === 'ENOENT') {
        console.warn('Warning:', error.message);
        return;
      }
      reject(error);
    });

    archive.on('error', reject);
    archive.pipe(output);

    archive.append(JSON.stringify(manifest, null, 2), { name: 'tracker-package.json' });
    archive.append(JSON.stringify(effectiveSettings, null, 2), { name: SETTINGS_EFFECTIVE_DEST });

    for (const file of FILE_MAPPINGS) {
      const fullSource = path.join(ROOT_DIR, file.src);
      if (!fs.existsSync(fullSource)) {
        reject(new Error(`Missing runtime package source file: ${file.src}`));
        return;
      }
      archive.file(fullSource, { name: file.dest });
    }

    archive.finalize().catch(reject);
  });
}

async function runFromCli() {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await buildRuntimeTrackerPackage(args);
  console.log(`Runtime tracker package built: ${result.outputPath}`);
  console.log(`Manifest service=${result.manifest.serviceName} hostApiVersion=${result.manifest.hostApiVersion} dtoContractVersion=${result.manifest.dtoContractVersion}`);
}

if (require.main === module) {
  runFromCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Build failed: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRuntimeTrackerPackage,
  buildEffectiveSettingsDocument,
  buildManifest,
  resolveHostApiVersion,
};
