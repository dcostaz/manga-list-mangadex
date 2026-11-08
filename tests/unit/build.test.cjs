'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { buildRuntimePluginPackage, locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');

test('the package holds the three layers, the manifest twice, the merged settings, the icon, and no SDK', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangadex-build-'));
    try {
        const { id } = locateTracker();
        const { outputPath } = await buildRuntimePluginPackage({ outputPath: path.join(dir, 'out.zip') });
        const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
        const reg = `apiwrappers/reg-${id}`;
        assert.deepEqual(names, [
            'images/mangadex-icon.svg',
            `${reg}/client-${id}.cjs`,
            `${reg}/${id}-api-settings.json`,
            `${reg}/mapping-${id}.cjs`,
            `${reg}/plugin-${id}.cjs`,
            `${reg}/plugin-package.json`,
            'plugin-package.json',
        ].sort());
        const root = JSON.parse(await zip.file('plugin-package.json').async('string'));
        const beside = JSON.parse(await zip.file(`${reg}/plugin-package.json`).async('string'));
        assert.deepEqual(root, beside);
        assert.equal(root.entrypoints.pluginModule, `${reg}/plugin-${id}.cjs`);
        assert.equal(root.pluginContractVersion, '4.0.0');
        const settings = JSON.parse(await zip.file(`${reg}/${id}-api-settings.json`).async('string'));
        assert.deepEqual(Object.keys(settings).sort(), ['metadata', 'schema', 'settings']);
        assert.equal(settings.metadata.componentName, 'MangaDexAPI', 'unchanged, so saved overrides still apply');
        for (const deleted of ['cache.enabled', 'cache.provider', 'retry.retryableErrors', 'resilience.healthCheck.enabled', 'ui.credentialsTemplate', 'rateLimit.perEndpoint.manga', 'statusMapping.READING']) {
            assert.equal(settings.settings[deleted], undefined, `${deleted} (Decision 5) does not ship`);
            assert.equal(settings.schema[deleted], undefined, `${deleted} has no schema entry`);
        }
        assert.equal(settings.settings['ui.icon'], root.iconPath, 'the icon the settings name is the one the package ships');
        assert.equal(settings.settings['api.authUrl'], 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the manifest\'s credential fields keep the 3.x keys, so stored credentials keep working (A12)', () => {
    const { manifest } = locateTracker();
    assert.deepEqual(manifest.credentialOptions.fields.map((/** @type {any} */ f) => f.key), ['username', 'password', 'client_id', 'client_secret']);
    assert.deepEqual(manifest.searchOptions, { requiresCredential: true }, 'MangaDex search is authenticated (owner ruling 2026-07-17)');
    assert.deepEqual(manifest.retrieveOptions, { requiresCredential: false });
});
