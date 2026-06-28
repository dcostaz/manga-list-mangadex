#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const pkg = require('../package.json');
const { PLUGIN_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'src', 'runtime', 'apiwrappers', 'plugindtocontract.cjs'));

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SETTINGS_DEFINITION_SOURCE = path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'mangadex-api-settings.definition.json');
const SETTINGS_VALUES_SOURCE = path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'mangadex-api-settings.values.json');
const SETTINGS_EFFECTIVE_DEST = 'apiwrappers/reg-mangadex/mangadex-api-settings.json';

/** @type {Array<{ src: string, dest: string }>} */
const FILE_MAPPINGS = [
  { src: path.join('src', 'runtime', 'apiwrappers', 'plugindtocontract.cjs'), dest: 'apiwrappers/plugindtocontract.cjs' },
  { src: path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'plugin-module.cjs'), dest: 'apiwrappers/reg-mangadex/plugin-module.cjs' },
  { src: path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'api-wrapper-mangadex.cjs'), dest: 'apiwrappers/reg-mangadex/api-wrapper-mangadex.cjs' },
  { src: path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'api-settings-mangadex.cjs'), dest: 'apiwrappers/reg-mangadex/api-settings-mangadex.cjs' },
  { src: path.join('src', 'runtime', 'apiwrappers', 'reg-mangadex', 'mapper-mangadex.cjs'), dest: 'apiwrappers/reg-mangadex/mapper-mangadex.cjs' },
  { src: path.join('src', 'runtime', 'images', 'mangadex-icon.svg'), dest: 'images/mangadex-icon.svg' },
];

function parseCliArgs(argv) {
  let outputPath = null;
  let hostApiVersion = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--output') { outputPath = argv[i + 1] || null; i++; continue; }
    if (token === '--host-api-version') { hostApiVersion = argv[i + 1] || null; i++; continue; }
    positional.push(token);
  }
  if (!outputPath && positional.length > 0) outputPath = positional[0];
  if (!hostApiVersion && positional.length > 1) hostApiVersion = positional[1];
  return { outputPath, hostApiVersion };
}

function resolveHostApiVersion(explicitVersion) {
  return String(explicitVersion || process.env.MANGALIST_HOST_API_VERSION || '1.0.0').trim() || '1.0.0';
}

function resolveOutputPath(explicitPath) {
  if (explicitPath && explicitPath.trim()) return path.resolve(explicitPath.trim());
  return path.join(DIST_DIR, `manga-list-mangadex-runtime-${pkg.version}.zip`);
}

function ensureDistDir() {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
}

function readJsonObjectFile(fullPath, label) {
  if (!fs.existsSync(fullPath)) throw new Error(`Missing ${label} file: ${fullPath}`);
  const raw = fs.readFileSync(fullPath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON in ${label}: ${e.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Expected object in ${label}`);
  return parsed;
}

function getObjectProperty(source, key, label) {
  const value = source[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object property '${key}' in ${label}`);
  return value;
}

function buildEffectiveSettingsDocument() {
  const definitionDoc = readJsonObjectFile(path.join(ROOT_DIR, SETTINGS_DEFINITION_SOURCE), 'settings definition');
  const valuesDoc = readJsonObjectFile(path.join(ROOT_DIR, SETTINGS_VALUES_SOURCE), 'settings values');
  const definitionSchema = getObjectProperty(definitionDoc, 'schema', 'settings definition');
  const valuesSettings = getObjectProperty(valuesDoc, 'settings', 'settings values');
  const effectiveSettings = {};
  for (const [key, schemaEntryRaw] of Object.entries(definitionSchema)) {
    const schemaEntry = schemaEntryRaw && typeof schemaEntryRaw === 'object' && !Array.isArray(schemaEntryRaw) ? schemaEntryRaw : null;
    if (!schemaEntry) throw new Error(`Invalid schema definition for key '${key}'`);
    if (Object.prototype.hasOwnProperty.call(valuesSettings, key)) { effectiveSettings[key] = valuesSettings[key]; continue; }
    if (Object.prototype.hasOwnProperty.call(schemaEntry, 'default')) { effectiveSettings[key] = schemaEntry.default; continue; }
    if (schemaEntry.required === true) throw new Error(`Missing required setting value for key '${key}'`);
  }
  for (const key of Object.keys(valuesSettings)) {
    if (!Object.prototype.hasOwnProperty.call(definitionSchema, key)) throw new Error(`Values file includes undefined setting key '${key}'`);
  }
  return {
    metadata: { ...getObjectProperty(definitionDoc, 'metadata', 'settings definition') },
    schema: definitionSchema,
    settings: effectiveSettings,
  };
}

function buildManifest(hostApiVersion) {
  const pluginPackagePath = path.join(ROOT_DIR, 'src', 'runtime', 'apiwrappers', 'reg-mangadex', 'plugin-package.json');
  const pluginPackage = readJsonObjectFile(pluginPackagePath, 'plugin-package.json');
  const contractVersion = typeof pluginPackage.pluginContractVersion === 'string' ? pluginPackage.pluginContractVersion : '1.0.0';
  const contractMajor = contractVersion.split('.')[0];
  const pluginContractMajor = PLUGIN_CONTRACT_VERSION.split('.')[0];
  if (contractMajor !== pluginContractMajor) {
    throw new Error(`pluginContractVersion major mismatch: plugin-package.json says ${contractVersion}, PLUGIN_CONTRACT_VERSION is ${PLUGIN_CONTRACT_VERSION}`);
  }
  return { ...pluginPackage, hostApiVersion };
}

function buildMangadexPackage(options = {}) {
  ensureDistDir();
  const outputPath = resolveOutputPath(options.outputPath || null);
  const hostApiVersion = resolveHostApiVersion(options.hostApiVersion || null);
  const manifest = buildManifest(hostApiVersion);
  const effectiveSettings = buildEffectiveSettingsDocument();

  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => resolve({ outputPath, manifest, fileCount: FILE_MAPPINGS.length + 2 }));
    archive.on('warning', (e) => { if (e.code === 'ENOENT') { console.warn('Warning:', e.message); return; } reject(e); });
    archive.on('error', reject);
    archive.pipe(output);

    archive.append(JSON.stringify(manifest, null, 2), { name: 'plugin-package.json' });
    archive.append(JSON.stringify(effectiveSettings, null, 2), { name: SETTINGS_EFFECTIVE_DEST });

    for (const file of FILE_MAPPINGS) {
      const fullSource = path.join(ROOT_DIR, file.src);
      if (!fs.existsSync(fullSource)) { reject(new Error(`Missing source file: ${file.src}`)); return; }
      archive.file(fullSource, { name: file.dest });
    }

    archive.finalize().catch(reject);
  });
}

async function runFromCli() {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await buildMangadexPackage(args);
  console.log(`Plugin package built: ${result.outputPath}`);
  console.log(`pluginName=${result.manifest.pluginName} hostApiVersion=${result.manifest.hostApiVersion}`);
}

if (require.main === module) {
  runFromCli().catch((error) => {
    console.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { buildManifest, buildMangadexPackage, buildEffectiveSettingsDocument };
