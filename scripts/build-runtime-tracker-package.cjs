#!/usr/bin/env node
'use strict';

/**
 * build-runtime-tracker-package.cjs
 *
 * Builds a distributable zip archive of the manga-list runtime tracker package.
 * The zip contains the source files needed to run the tracker in any environment.
 *
 * Output: dist/manga-list-tracker-<version>.zip
 */

const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT_FILENAME = `manga-list-tracker-${pkg.version}.zip`;
const OUTPUT_PATH = path.join(DIST_DIR, OUTPUT_FILENAME);

/** Files and directories to include in the package */
const INCLUDE_PATTERNS = [
  { src: 'src', dest: 'src' },
  { src: 'package.json', dest: 'package.json' },
  { src: 'README.md', dest: 'README.md' },
];

function ensureDistDir() {
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }
}

function buildPackage() {
  ensureDistDir();

  const output = fs.createWriteStream(OUTPUT_PATH);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      const sizeKb = (archive.pointer() / 1024).toFixed(2);
      console.log(`✔ Package built: ${OUTPUT_FILENAME} (${sizeKb} KB)`);
      resolve(OUTPUT_PATH);
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('Warning:', err.message);
      } else {
        reject(err);
      }
    });

    archive.on('error', reject);

    archive.pipe(output);

    for (const pattern of INCLUDE_PATTERNS) {
      const fullSrc = path.join(ROOT_DIR, pattern.src);
      if (!fs.existsSync(fullSrc)) {
        console.warn(`Skipping missing path: ${pattern.src}`);
        continue;
      }

      const stat = fs.statSync(fullSrc);
      if (stat.isDirectory()) {
        archive.directory(fullSrc, pattern.dest);
      } else {
        archive.file(fullSrc, { name: pattern.dest });
      }
    }

    archive.finalize();
  });
}

buildPackage().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
