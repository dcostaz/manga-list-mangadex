#!/usr/bin/env node
'use strict';

/**
 * The nothing-lost check (Plan-2026Q4-tracker-plugin-standardization, Phase 4.1): every public method of the
 * 3.x wrapper — read from the `contract-3-final` tag, so the rebuild cannot hide one by deleting it — appears
 * exactly once in docs/nothing-lost.md's table, with one of the four classifications, and the table names no
 * method the old wrapper did not have.
 *
 *   node scripts/check-nothing-lost.cjs [--ref contract-3-final]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLASSIFICATIONS = ['contract', 'to client', 'to mapping', 'deleted'];

/** @param {string[]} args */
const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });

function main() {
    const refIndex = process.argv.indexOf('--ref');
    const ref = refIndex >= 0 ? process.argv[refIndex + 1] : 'contract-3-final';
    const wrapperPath = git(['ls-tree', '-r', '--name-only', ref])
        .split('\n')
        .find((file) => /src\/runtime\/apiwrappers\/reg-[^/]+\/api-wrapper-[^/]+\.cjs$/.test(file));
    if (!wrapperPath) throw new Error(`no api-wrapper-*.cjs at ${ref}`);
    const source = git(['show', `${ref}:${wrapperPath}`]);

    /** @type {Set<string>} */
    const methods = new Set();
    for (const match of source.matchAll(/^ {2}(?:static )?(?:async )?(?:get |set )?([A-Za-z][A-Za-z0-9]*)\s*\(/gm)) {
        if (!['if', 'for', 'while', 'switch', 'catch', 'return'].includes(match[1])) methods.add(match[1]);
    }

    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'nothing-lost.md'), 'utf8');
    /** @type {Map<string, string[]>} */
    const rows = new Map();
    for (const match of doc.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|\s*([^|]+?)\s*\|/gm)) {
        const list = rows.get(match[1]) || [];
        list.push(match[2].toLowerCase());
        rows.set(match[1], list);
    }

    /** @type {string[]} */
    const problems = [];
    for (const method of methods) {
        const found = rows.get(method);
        if (!found) problems.push(`'${method}' (a public method at ${ref}) has no row`);
        else if (found.length > 1) problems.push(`'${method}' has ${found.length} rows`);
        else if (!CLASSIFICATIONS.some((c) => found[0].startsWith(c))) problems.push(`'${method}' is classified '${found[0]}', not one of: ${CLASSIFICATIONS.join(', ')}`);
    }
    for (const name of rows.keys()) {
        if (!methods.has(name)) problems.push(`'${name}' has a row but was not a public method at ${ref}`);
    }

    if (problems.length) {
        process.stderr.write(`nothing-lost: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
        process.exit(1);
    }
    process.stdout.write(`nothing-lost: all ${methods.size} public methods of ${wrapperPath}@${ref} are classified\n`);
}

main();
