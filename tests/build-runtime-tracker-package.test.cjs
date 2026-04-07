'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const JSZip = require('jszip');

const {
  buildRuntimeTrackerPackage,
  buildEffectiveSettingsDocument,
  buildManifest,
} = require('../scripts/build-runtime-tracker-package.cjs');

/**
 * @returns {Promise<string>}
 */
async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'manga-list-mangadex-build-test-'));
}

test('buildManifest returns runtime loader compatible metadata', () => {
  const manifest = buildManifest('1.0.0');

  assert.equal(manifest.serviceName, 'mangadex');
  assert.equal(manifest.wrapperId, 'mangadex');
  assert.equal(manifest.hostApiVersion, '1.0.0');
  assert.equal(typeof manifest.dtoContractVersion, 'string');
  assert.equal(manifest.entrypoints.trackerModule, 'apiwrappers/reg-mangadex/tracker-module.cjs');
  assert.equal(manifest.entrypoints.mapperModule, 'apiwrappers/reg-mangadex/mapper-mangadex.cjs');
  assert.equal(manifest.entrypoints.settingsFile, 'apiwrappers/reg-mangadex/mangadex-api-settings.json');
});

test('buildEffectiveSettingsDocument merges definition and values into runtime payload', () => {
  const effective = buildEffectiveSettingsDocument();

  assert.equal(effective.metadata.componentName, 'MangaDexAPI');
  assert.equal(effective.metadata.settingsContractVersion, '1.0.0');
  assert.equal(typeof effective.schema['api.baseUrl'], 'object');
  assert.equal(typeof effective.schema['api.endpoints.manga.template'], 'object');
  assert.equal(effective.settings['api.baseUrl'], 'https://api.mangadex.org');
  assert.equal(effective.settings['api.endpoints.manga.template'], '${baseUrl}/manga');
  assert.equal(effective.settings['statusMapping.READING'], 'reading');
});

test('buildRuntimeTrackerPackage creates zip with tracker-package.json and runtime files', async () => {
  const tempDir = await createTempDir();
  const outputPath = path.join(tempDir, 'mangadex-runtime.zip');

  try {
    const result = await buildRuntimeTrackerPackage({ outputPath, hostApiVersion: '1.2.3' });
    assert.equal(result.outputPath, outputPath);

    const zipBuffer = await fs.readFile(outputPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = Object.keys(zip.files)
      .filter((entry) => !entry.endsWith('/'))
      .sort((a, b) => a.localeCompare(b));

    assert.deepEqual(entries, [
      'apiwrappers/reg-mangadex/api-settings-mangadex.cjs',
      'apiwrappers/reg-mangadex/api-wrapper-mangadex.cjs',
      'apiwrappers/reg-mangadex/mangadex-api-settings.definition.json',
      'apiwrappers/reg-mangadex/mangadex-api-settings.json',
      'apiwrappers/reg-mangadex/mangadex-api-settings.values.json',
      'apiwrappers/reg-mangadex/mapper-mangadex.cjs',
      'apiwrappers/reg-mangadex/tracker-module.cjs',
      'apiwrappers/trackerdtocontract.cjs',
      'tracker-package.json',
    ]);

    const manifestFile = zip.file('tracker-package.json');
    assert.ok(manifestFile);
    const manifestRaw = await manifestFile.async('string');
    const manifest = JSON.parse(manifestRaw);

    assert.equal(manifest.serviceName, 'mangadex');
    assert.equal(manifest.hostApiVersion, '1.2.3');
    assert.equal(manifest.entrypoints.trackerModule, 'apiwrappers/reg-mangadex/tracker-module.cjs');
    assert.equal(manifest.entrypoints.mapperModule, 'apiwrappers/reg-mangadex/mapper-mangadex.cjs');
    assert.equal(manifest.entrypoints.settingsFile, 'apiwrappers/reg-mangadex/mangadex-api-settings.json');

    const settingsFile = zip.file('apiwrappers/reg-mangadex/mangadex-api-settings.json');
    assert.ok(settingsFile);
    const settingsRaw = await settingsFile.async('string');
    const effectiveSettings = JSON.parse(settingsRaw);
    assert.equal(effectiveSettings.metadata.componentName, 'MangaDexAPI');
    assert.equal(effectiveSettings.settings['api.authUrl'], 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect');
    assert.equal(effectiveSettings.settings['api.endpoints.status.template'], '${baseUrl}/manga/${id}/status');
    assert.equal(effectiveSettings.settings['rateLimit.perEndpoint.manga'], 1000);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
