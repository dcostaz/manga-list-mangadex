'use strict';

/**
 * L3a — the definition: DECLARE and bind (Plan-2026Q4-tracker-plugin-standardization §1.2–§1.3).
 *
 * The SDK builds the descriptor the host loads ({ pluginName, displayName, WrapperClass, SettingsClass }) from
 * the manifest, the client's auth strategy and factory, and the mapping. Every method the declared offers need is
 * bound by convention — `mapping.<method>(await client.<method>(...))` — so this file is the same for every
 * tracker built from the template: it names its siblings from the manifest's pluginName. Add explicit `methods`
 * here only where a source cannot follow the convention.
 */

const { defineTrackerPlugin } = require('@manga-list/plugin-sdk');
const manifest = require('./plugin-package.json');
const { createClient, auth } = require(`./client-${manifest.pluginName}.cjs`);
const mapping = require(`./mapping-${manifest.pluginName}.cjs`);

module.exports = defineTrackerPlugin({
    manifest,
    auth,
    createClient,
    mapping,
    methods: {
        // MangaDex answers up to 100 manga ids in one `GET /manga?ids[]=` call; the convention would call the
        // source once per entry (a card grid's worth of calls under a 1 s throttle). One call per hundred ids, one
        // result per id in the host's order; a throw becomes every entry's failure in the SDK (§2.1).
        summarizeEntries: async (view, ids) => mapping.summarizeEntries(await view.client.summarizeEntries(ids), ids),
        // Title mode must decide which manga a title names between two source calls (search, then covers); the decision
        // is the mapping's, and the client never imports the mapping (L4 does not depend on L3b). Id mode skips the
        // search. Title and alternates are searched in turn until an exact match (unless search.exactMatchPolicy is
        // highestScore).
        searchCovers: async (view, query, options) => {
            let mangaId = options && typeof options.pluginEntryId === 'string' && options.pluginEntryId ? options.pluginEntryId : '';
            if (!mangaId) {
                const titles = [query && query.title, ...(query && Array.isArray(query.altTitles) ? query.altTitles : [])];
                const wanted = [...new Set(titles.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))];
                /** @type {any} */
                let best = null;
                for (const title of wanted) {
                    const found = await view.client.searchTitle(title);
                    const pick = mapping.pickMatch(best, found.rows, wanted, found.policy);
                    best = pick.best;
                    if (pick.done) break;
                }
                if (!best) return [];
                mangaId = String(best.row.id);
            }
            return mapping.searchCovers({ mangaId, covers: await view.client.covers(mangaId) }, query, options);
        },
    },
});
