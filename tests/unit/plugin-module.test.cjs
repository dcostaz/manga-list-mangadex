'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pluginModule = require('../../src/runtime/apiwrappers/reg-mangadex/plugin-module.cjs');

test('declares the name the host shows for it', () => {
  assert.equal(pluginModule.displayName, 'MangaDex');
});
