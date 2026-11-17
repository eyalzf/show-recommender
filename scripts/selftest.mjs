// Self-test for the engine's pure helpers (worker/src/util.ts).
// Bundles util.ts with esbuild and runs assertions in plain Node.
// Run: node scripts/selftest.mjs (uses the repo's esbuild install).
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'node_modules', '.selftest-util.mjs');
await build({
  entryPoints: [join(root, 'worker', 'src', 'util.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
});
const util = await import(outFile);
await unlink(outFile).catch(() => {});

// normalizeTitle
assert.equal(util.normalizeTitle('Fauda!'), 'fauda');
assert.equal(util.normalizeTitle('  Kupa   Rashit '), 'kupa rashit');
assert.equal(util.normalizeTitle('נֶבְסוּ'), 'נבסו'); // niqqud stripped
assert.equal(util.normalizeTitle('Beauty and the Baker'), 'beauty and the baker');

// cosine
assert.equal(util.cosine([1, 0], [0, 1]), 0);
assert.ok(Math.abs(util.cosine([1, 2], [1, 2]) - 1) < 1e-9);
assert.equal(util.cosine([], []), 0);

// classifyKind — genre IDs, never localized names. Regression:
// 2026-11-15, a Hebrew UI profile got an empty casual list because the
// classifier matched English names ('Comedy') against Hebrew ones
// ('קומדיה') and defaulted everything to deep. IDs used below:
// 35 Comedy, 18 Drama, 80 Crime, 10764 Reality, 99 Documentary.
assert.equal(util.classifyKind([35]), 'casual');
assert.equal(util.classifyKind([18, 80]), 'deep');
assert.equal(util.classifyKind([35, 18]), 'deep'); // tie -> Drama wins
assert.equal(util.classifyKind([10764]), 'casual');
assert.equal(util.classifyKind([99]), 'deep');
assert.equal(util.classifyKind([]), 'deep');

// Hazbin rule (classification fix, 2026-11-15): Animation + Comedy
// with no Crime/Mystery reads casual even with Drama/Sci-Fi tags.
// IDs: 16 Animation, 10765 Sci-Fi & Fantasy, 9648 Mystery.
assert.equal(util.classifyKind([16, 35, 18, 10765]), 'casual'); // Hazbin Hotel
assert.equal(util.classifyKind([16, 35, 18]), 'casual');
assert.equal(util.classifyKind([16, 35]), 'casual');
assert.equal(util.classifyKind([16, 35, 80, 18]), 'deep'); // Crime opts out -> tie -> Drama
assert.equal(util.classifyKind([16, 35, 9648, 18]), 'deep'); // Mystery opts out -> tie -> Drama
assert.equal(util.classifyKind([16, 18]), 'deep'); // Animation + Drama, no Comedy -> tie -> Drama
// Tulsa King / Eureka stay heuristic-deep; the kind-fit prompt (not
// the heuristic) is what keeps them out of the wrong list.
assert.equal(util.classifyKind([80, 18, 35]), 'deep'); // Tulsa King
assert.equal(util.classifyKind([10765, 35, 18]), 'deep'); // Eureka
// Pure-genre / tie-break regressions.
assert.equal(util.classifyKind([16]), 'casual');
assert.equal(util.classifyKind([10765]), 'deep');
assert.equal(util.classifyKind([35, 10764]), 'casual');
assert.equal(util.classifyKind([18, 99]), 'deep');
assert.equal(util.classifyKind([35, 99]), 'casual'); // tie, no Drama -> Comedy wins

// classifyType
assert.equal(util.classifyType([10764], 3, 30, 'Returning Series'), 'reality');
assert.equal(util.classifyType([99], 1, 4, 'Ended'), 'docuseries');
assert.equal(util.classifyType([18], 1, 8, 'Ended'), 'limited');
assert.equal(util.classifyType([18], 1, 20, 'Ended'), 'series');
assert.equal(util.classifyType([18], 3, 30, 'Ended'), 'series');

// tone / pace / structure
assert.equal(util.toneFor([35]), 'Light');
assert.equal(util.toneFor([9648]), 'Tense');
assert.equal(util.toneFor([18]), 'Serious');
assert.equal(util.toneFor([99]), 'Curious');
assert.equal(util.toneFor([10764]), 'Easy');
assert.equal(util.toneFor([10765]), 'Imaginative');
assert.equal(util.paceFor(25), 'Brisk');
assert.equal(util.paceFor(45), 'Steady');
assert.equal(util.paceFor(60), 'Unhurried');
assert.equal(util.paceFor(null), 'Steady');
assert.equal(util.structureFor([35]), 'episodic');
assert.equal(util.structureFor([18]), 'serialized');

// displaySeasons: season 0 (specials) never counts
assert.equal(
  util.displaySeasons([{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }], 3),
  2,
);
assert.equal(util.displaySeasons(null, 4), 4);

// displayEpisodes: season 0 episodes never count; falls back to the total
assert.equal(
  util.displayEpisodes(
    [
      { season_number: 0, episode_count: 5 },
      { season_number: 1, episode_count: 10 },
      { season_number: 2, episode_count: 8 },
    ],
    23,
  ),
  18,
);
assert.equal(util.displayEpisodes(null, 40), 40);
assert.equal(util.displayEpisodes([{ season_number: 0, episode_count: 3 }], 3), 3);

// clusterFor: genre IDs, fixed priority order (Animation wins over Comedy)
assert.equal(util.clusterFor([16, 35]), 'animation');
assert.equal(util.clusterFor([35]), 'comedy');
assert.equal(util.clusterFor([18]), 'drama');
assert.equal(util.clusterFor([80]), 'crime');
assert.equal(util.clusterFor([10765]), 'scifi');
assert.equal(util.clusterFor([99]), 'documentary');
assert.equal(util.clusterFor([10764]), 'reality');
assert.equal(util.clusterFor([10759]), 'action');
assert.equal(util.clusterFor([9648]), 'mystery');
assert.equal(util.clusterFor([10751]), 'family');
assert.equal(util.clusterFor([10767]), 'talk');
assert.equal(util.clusterFor([18, 80]), 'drama'); // Drama outranks Crime
assert.equal(util.clusterFor([]), 'other');

// Diversity caps: strict picks first, deferred fill only narrow pools
const capItems = [
  { id: 1, g: [16] }, { id: 2, g: [16] }, { id: 3, g: [16] }, { id: 4, g: [16] },
  { id: 5, g: [35] }, { id: 6, g: [18] }, { id: 7, g: [18] }, { id: 8, g: [80] },
];
const part = util.partitionByClusterCap(capItems, (x) => util.clusterFor(x.g), 3);
assert.deepEqual(part.picked.map((x) => x.id), [1, 2, 3, 5, 6, 7, 8]);
assert.deepEqual(part.deferred.map((x) => x.id), [4]);
assert.deepEqual(
  util.selectCapped(capItems, (x) => util.clusterFor(x.g), 3, 5).map((x) => x.id),
  [1, 2, 3, 5, 6],
);
// Strict Top 10 selection: ONLY strict picks surface — a slice of the
// picked list can never exceed the cap, even when the ranked list is
// cluster-dominated (regression: the old reorder+slice pulled deferred
// items back in whenever picked < 10).
const dominated = [
  { id: 1, g: [35] }, { id: 2, g: [35] }, { id: 3, g: [35] }, { id: 4, g: [35] },
  { id: 5, g: [35] }, { id: 6, g: [35] }, { id: 7, g: [35] }, { id: 8, g: [18] },
  { id: 9, g: [99] },
];
const strictTop = util.partitionByClusterCap(dominated, (x) => util.clusterFor(x.g), 3).picked.slice(0, 10);
assert.deepEqual(strictTop.map((x) => x.id), [1, 2, 3, 8, 9]);
assert.equal(strictTop.filter((x) => util.clusterFor(x.g) === 'comedy').length, 3);
// Narrow pool: the cap relaxes, deferred items fill the remaining slots
const narrow = [{ id: 1, g: [16] }, { id: 2, g: [16] }, { id: 3, g: [16] }, { id: 4, g: [16] }];
assert.deepEqual(
  util.selectCapped(narrow, (x) => util.clusterFor(x.g), 3, 4).map((x) => x.id),
  [1, 2, 3, 4],
);
// A short input stays short — caps never invent items
assert.deepEqual(
  util.selectCapped(narrow.slice(0, 2), (x) => util.clusterFor(x.g), 3, 10).map((x) => x.id),
  [1, 2],
);

// parseRankResponse: validates ids, dedupes, tolerates prose around JSON
const rankText = 'Here you go:\n{"ranked": [{"tmdbId": 1, "rationale": "fits", "risk": null}, {"tmdbId": 999, "rationale": "invented"}], "shortReason": null}';
const parsed = util.parseRankResponse(rankText, new Set([1, 2]));
assert.equal(parsed.ranked.length, 1);
assert.equal(parsed.ranked[0].tmdbId, 1);
assert.equal(util.parseRankResponse('no json here', new Set([1])), null);
assert.equal(util.parseRankResponse('{"ranked": []}', new Set([1])), null);

// parseConsolidationResponse: all-empty sections JSON is honored as
// empty — the raw JSON must never be stored as summary text (2026-11-15:
// a background consolidation with no notes yet saved the JSON itself).
const emptySec = util.parseConsolidationResponse(
  '{"summary": {"shared": "", "casual": "", "deep": ""}, "contradictions": [], "languageConflict": null}',
);
assert.equal(emptySec.summary, '');
assert.deepEqual(emptySec.sections, { shared: '', casual: '', deep: '' });
assert.equal(emptySec.contradictions.length, 0);
const emptyStr = util.parseConsolidationResponse('{"summary": "", "contradictions": []}');
assert.equal(emptyStr.summary, '');
assert.deepEqual(emptyStr.sections, { shared: '', casual: '', deep: '' });

// parseConsolidationResponse: JSON contract + plain-text fallback
const con = util.parseConsolidationResponse(
  '{"summary": "Loves drama.", "contradictions": [{"oldText": "a", "newText": "b", "proposedMerge": "c"}], "languageConflict": {"languageCode": "ko", "languageName": "Korean"}}',
);
assert.equal(con.summary, 'Loves drama.');
assert.equal(con.sections.shared, 'Loves drama.');
assert.equal(con.sections.casual, '');
assert.equal(con.contradictions.length, 1);
assert.equal(con.contradictions[0].scope, 'shared'); // legacy: no scope -> shared
assert.equal(con.languageConflict.languageCode, 'ko');
const plain = util.parseConsolidationResponse('Just a plain summary.');
assert.equal(plain.summary, 'Just a plain summary.');
assert.equal(plain.sections.shared, 'Just a plain summary.');
assert.equal(plain.contradictions.length, 0);

// parseConsolidationResponse: sectioned contract + scoped contradictions
const sec = util.parseConsolidationResponse(
  '{"summary": {"shared": "Loves drama.", "casual": "Light evenings only.", "deep": "Slow burns welcome."}, "contradictions": [{"scope": "casual", "oldText": "a", "newText": "b", "proposedMerge": "c"}, {"scope": "bogus", "oldText": "d", "newText": "e", "proposedMerge": "f"}], "languageConflict": null}',
);
assert.equal(sec.sections.shared, 'Loves drama.');
assert.equal(sec.sections.casual, 'Light evenings only.');
assert.equal(sec.sections.deep, 'Slow burns welcome.');
assert.equal(sec.summary, 'Loves drama.\nLight evenings only.\nSlow burns welcome.');
assert.equal(sec.contradictions.length, 2);
assert.equal(sec.contradictions[0].scope, 'casual');
assert.equal(sec.contradictions[1].scope, 'shared'); // invalid scope -> shared
assert.equal(sec.languageConflict, null);

// Taste sections: storage round-trip + legacy fallback
assert.deepEqual(util.parseTasteSummary(null), { shared: '', casual: '', deep: '' });
assert.deepEqual(util.parseTasteSummary(''), { shared: '', casual: '', deep: '' });
assert.deepEqual(util.parseTasteSummary('Plain old summary.'), {
  shared: 'Plain old summary.',
  casual: '',
  deep: '',
});
assert.deepEqual(util.parseTasteSummary('{"not": "a summary"}'), {
  shared: '{"not": "a summary"}',
  casual: '',
  deep: '',
});
const stored = util.serializeTasteSummary({ shared: 's', casual: 'c', deep: 'd' });
assert.deepEqual(util.parseTasteSummary(stored), { shared: 's', casual: 'c', deep: 'd' });
assert.equal(util.serializeTasteSummary({ shared: 'only shared', casual: '', deep: '' }), 'only shared');
assert.equal(util.serializeTasteSummary({ shared: '', casual: '', deep: '' }), '');

// --- preference rules: fixed lists + validation ---
assert.equal(util.TMDB_TV_GENRES.length, 16);
assert.ok(util.TMDB_TV_GENRES.some((g) => g.id === 10764 && g.name === 'Reality'));
assert.equal(util.TMDB_TV_STATUSES.length, 6);
assert.ok(util.TMDB_TV_STATUSES.includes('Ended'));
assert.ok(util.TMDB_TV_STATUSES.includes('Returning Series'));
assert.equal(util.ISO_COUNTRY_CODES.size, 251);
assert.ok(util.ISO_COUNTRY_CODES.has('US') && util.ISO_COUNTRY_CODES.has('IL'));

const R = (dimension, operator, value, mode) => ({ dimension, operator, value, mode });
assert.deepEqual(
  util.validateRules([
    R('genre', 'isNot', 10764, 'hard'),
    R('year', 'gte', 2000, 'hard'),
    R('country', 'is', 'KR', 'soft'),
    R('status', 'is', 'Ended', 'hard'),
    R('seasons', 'gte', 3, 'soft'),
    R('episodeMinutes', 'lte', 30, 'soft'),
  ]),
  [
    R('genre', 'isNot', 10764, 'hard'),
    R('year', 'gte', 2000, 'hard'),
    R('country', 'is', 'KR', 'soft'),
    R('status', 'is', 'Ended', 'hard'),
    R('seasons', 'gte', 3, 'soft'),
    R('episodeMinutes', 'lte', 30, 'soft'),
  ],
);
// Unknown genre id, wrong operator for the dimension, bad country
// code, bad status, out-of-range numerics: all dropped.
assert.deepEqual(
  util.validateRules([
    R('genre', 'isNot', 99999, 'hard'),
    R('genre', 'gte', 35, 'hard'),
    R('country', 'is', 'XX', 'hard'),
    R('status', 'is', 'Ongoing', 'hard'),
    R('year', 'gte', 1800, 'hard'),
    R('year', 'lte', 3000, 'hard'),
    R('seasons', 'gte', 0, 'hard'),
    R('episodeMinutes', 'lte', 999, 'hard'),
    R('nope', 'is', 1, 'hard'),
    R('genre', 'isNot', 10764.5, 'hard'),
    'garbage',
    null,
  ]),
  [],
);
// Country codes normalize to uppercase; mode defaults to soft
// (fail-safe: a malformed rule never becomes a hard filter).
assert.deepEqual(util.validateRules([R('country', 'is', 'us', 'hard')]), [R('country', 'is', 'US', 'hard')]);
assert.deepEqual(util.validateRules([{ dimension: 'genre', operator: 'is', value: 35 }]), [
  R('genre', 'is', 35, 'soft'),
]);
assert.deepEqual(util.validateRules([R('genre', 'is', 35, 'banana')]), [R('genre', 'is', 35, 'soft')]);
// Duplicates collapse; the list caps at MAX_PREFERENCE_RULES.
assert.deepEqual(
  util.validateRules([R('genre', 'isNot', 10764, 'hard'), R('genre', 'isNot', 10764, 'hard')]),
  [R('genre', 'isNot', 10764, 'hard')],
);
const manyRules = Array.from({ length: 25 }, (_, i) => R('year', 'gte', 1900 + i, 'soft'));
assert.equal(util.validateRules(manyRules).length, util.MAX_PREFERENCE_RULES);
assert.deepEqual(util.validateRules(null), []);
assert.deepEqual(util.validateRules('nope'), []);
assert.deepEqual(util.validateRules({}), []);

// --- legacy hardExcludes migration ---
assert.deepEqual(
  util.rulesFromLegacyExcludes({ genres: [10764, 35], minYear: 2000, maxYear: null }),
  [R('genre', 'isNot', 10764, 'hard'), R('genre', 'isNot', 35, 'hard'), R('year', 'gte', 2000, 'hard')],
);
assert.deepEqual(
  util.rulesFromLegacyExcludes({ genres: [10764, 99999], minYear: 2010, maxYear: 2000 }),
  [R('genre', 'isNot', 10764, 'hard')], // inverted range drops both years, keeps genres
);
assert.deepEqual(util.rulesFromLegacyExcludes(null), []);

// --- taste record round-trips (sections + rules) ---
const ruleRecord = {
  sections: { shared: 's', casual: '', deep: '' },
  rules: [R('genre', 'isNot', 10764, 'hard')],
};
const ruleStored = util.serializeTasteRecord(ruleRecord);
assert.ok(ruleStored.startsWith('{')); // Shared-only + rules => JSON, never plain text
assert.ok(!ruleStored.includes('hardExcludes')); // the legacy key is never written
assert.deepEqual(util.parseTasteRecord(ruleStored), ruleRecord);
assert.deepEqual(util.parseTasteRecord('Plain old summary.'), {
  sections: { shared: 'Plain old summary.', casual: '', deep: '' },
  rules: [],
});
assert.deepEqual(util.parseTasteRecord('{"v":1,"shared":"s","casual":"","deep":""}'), {
  sections: { shared: 's', casual: '', deep: '' },
  rules: [],
});
assert.deepEqual(
  util.parseTasteRecord('{"v":1,"shared":"s","casual":"","deep":"","hardExcludes":{"genres":[99999],"minYear":2000}}'),
  {
    sections: { shared: 's', casual: '', deep: '' },
    rules: [R('year', 'gte', 2000, 'hard')], // legacy key converted; invalid ids dropped on read
  },
);
assert.deepEqual(
  util.parseTasteRecord(
    '{"v":1,"shared":"s","casual":"","deep":"","rules":[{"dimension":"genre","operator":"is","value":35,"mode":"soft"}],"hardExcludes":{"genres":[10764],"minYear":null,"maxYear":null}}',
  ),
  {
    sections: { shared: 's', casual: '', deep: '' },
    rules: [R('genre', 'is', 35, 'soft'), R('genre', 'isNot', 10764, 'hard')], // merged + deduped
  },
);
assert.equal(
  util.serializeTasteRecord({ sections: { shared: 'only', casual: '', deep: '' }, rules: [] }),
  'only',
);

// --- ruleMatches / passesHardRules / softRuleScore ---
const facts = {
  genreIds: [35, 10764],
  year: 2005,
  originCountry: ['US'],
  status: 'Ended',
  seasons: 4,
  episodeMinutes: 30,
};
const unknown = {
  genreIds: [35],
  year: null,
  originCountry: [],
  status: null,
  seasons: null,
  episodeMinutes: null,
};
assert.equal(util.ruleMatches(facts, R('genre', 'isNot', 10764, 'hard')), false); // any-genre match
assert.equal(util.ruleMatches(facts, R('genre', 'is', 35, 'hard')), true);
assert.equal(util.ruleMatches(facts, R('year', 'gte', 2000, 'hard')), true);
assert.equal(util.ruleMatches(facts, R('year', 'lte', 2000, 'hard')), false);
assert.equal(util.ruleMatches(unknown, R('year', 'gte', 2000, 'hard')), null); // unknown -> null
assert.equal(util.ruleMatches(unknown, R('country', 'is', 'US', 'hard')), null);
assert.equal(util.ruleMatches(unknown, R('status', 'is', 'Ended', 'hard')), null);
assert.equal(util.ruleMatches(facts, R('seasons', 'lte', 3, 'hard')), false);
assert.equal(util.ruleMatches(facts, R('episodeMinutes', 'lte', 30, 'hard')), true);

const hardRules = [
  R('genre', 'isNot', 10764, 'hard'),
  R('year', 'gte', 2000, 'hard'),
  R('year', 'lte', 2010, 'hard'),
];
assert.equal(util.passesHardRules(facts, hardRules), false); // reality genre fails it
assert.equal(util.passesHardRules({ ...facts, genreIds: [35] }, hardRules), true);
assert.equal(util.passesHardRules({ ...facts, genreIds: [35], year: 1999 }, hardRules), false);
assert.equal(util.passesHardRules({ ...facts, genreIds: [35], year: 2011 }, hardRules), false);
assert.equal(util.passesHardRules(unknown, hardRules), true); // unknown facts fail open
assert.equal(util.passesHardRules(facts, []), true);
assert.equal(
  util.passesHardRules(facts, [R('genre', 'isNot', 10764, 'soft')]),
  true, // soft rules never filter
);
assert.equal(
  util.passesHardRules(facts, [R('seasons', 'lte', 3, 'hard')]),
  false, // detail dimension binds when facts are known
);
assert.equal(
  util.passesHardRules(unknown, [R('seasons', 'lte', 3, 'hard')]),
  true, // and passes open when unknown (ingestion stage)
);

// softRuleScore: mean over evaluable soft rules; +1 match,
// -distance miss (categorical = 1, numeric scaled + capped).
assert.equal(util.softRuleScore(facts, []), 0);
assert.equal(util.softRuleScore(facts, [R('genre', 'isNot', 10764, 'hard')]), 0); // hard rules don't score
assert.equal(util.softRuleScore(facts, [R('genre', 'is', 35, 'soft')]), 1);
assert.equal(util.softRuleScore(facts, [R('genre', 'isNot', 10764, 'soft')]), -1);
assert.equal(util.softRuleScore({ ...facts, year: 1990 }, [R('year', 'gte', 2000, 'soft')]), -0.4); // 10/25
assert.equal(util.softRuleScore({ ...facts, year: 1950 }, [R('year', 'gte', 2000, 'soft')]), -1); // capped
assert.equal(util.softRuleScore({ ...facts, seasons: 6 }, [R('seasons', 'lte', 3, 'soft')]), -0.6); // 3/5
assert.equal(
  util.softRuleScore(facts, [R('genre', 'is', 35, 'soft'), R('genre', 'isNot', 10764, 'soft')]),
  0, // mean of +1 and -1
);
assert.equal(
  util.softRuleScore(unknown, [R('genre', 'is', 35, 'soft'), R('seasons', 'gte', 10, 'soft')]),
  1, // unevaluable rule skipped, not diluting the mean
);
assert.equal(util.softRuleScore(unknown, [R('seasons', 'gte', 10, 'soft')]), 0);

// --- parseConsolidationResponse with rules ---
const conRules = util.parseConsolidationResponse(
  '{"summary": {"shared": "s", "casual": "", "deep": ""}, "contradictions": [], "languageConflict": null, "rules": [{"dimension": "genre", "operator": "isNot", "value": 10764, "mode": "hard"}, {"dimension": "genre", "operator": "isNot", "value": 424242, "mode": "hard"}]}',
);
assert.deepEqual(conRules.rules, [R('genre', 'isNot', 10764, 'hard')]); // invalid id dropped
const conNoRules = util.parseConsolidationResponse(
  '{"summary": {"shared": "s", "casual": "", "deep": ""}, "contradictions": []}',
);
assert.deepEqual(conNoRules.rules, []);
assert.deepEqual(util.parseConsolidationResponse('Just text.').rules, []);

// --- groundRules: inventions dropped, mild hard rules softened ---
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10767, 'hard')], ['לא אוהב תוכניות ריאליטי']),
  [], // Talk invented: no note names it
);
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10762, 'hard')], ['מעדיף לא תוכניות יומיות או תוכניות אקטואליה']),
  [], // Kids invented: no note names it
);
assert.deepEqual(
  util.groundRules(
    [R('genre', 'isNot', 10763, 'hard')],
    ['מעדיף לא תוכניות יומיות או תוכניות אקטואליה'],
  ),
  [R('genre', 'isNot', 10763, 'soft')], // grounded via אקטואליה, but "prefers not" is not categorical
);
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10764, 'hard')], ['לא אוהב תוכניות ריאליטי']),
  [R('genre', 'isNot', 10764, 'hard')], // categorical wording keeps it hard
);
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10764, 'hard')], ['מעדיף לא תוכניות ריאליטי']),
  [R('genre', 'isNot', 10764, 'soft')], // same category, mild wording only: soft
);
assert.deepEqual(
  util.groundRules(
    [R('genre', 'isNot', 10764, 'hard')],
    ['מעדיף לא תוכניות ריאליטי', 'לא אוהב תוכניות ריאליטי'],
  ),
  [R('genre', 'isNot', 10764, 'hard')], // any categorical grounding statement keeps it hard
);
assert.deepEqual(
  util.groundRules([R('year', 'gte', 2000, 'hard')], ['Nothing before 2000']),
  [R('year', 'gte', 2000, 'hard')],
);
assert.deepEqual(
  util.groundRules([R('year', 'gte', 2000, 'hard')], ['Shows from 2000 are nice']),
  [R('year', 'gte', 2000, 'soft')],
);
assert.deepEqual(
  util.groundRules([R('year', 'gte', 2011, 'soft')], ['I prefer shows after 2010']),
  [R('year', 'gte', 2011, 'soft')], // +/-1 boundary derivation still grounds
);

// --- groundRules: unified vocabulary (stems, countries, synonyms) ---
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10764, 'hard')], ['סדרות ללא ריאליטי']),
  [R('genre', 'isNot', 10764, 'hard')], // 'ללא' is categorical
);
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10764, 'hard')], ['I cannot stand reality shows']),
  [R('genre', 'isNot', 10764, 'hard')],
);
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10764, 'hard')], ["I'm sick of reality shows"]),
  [R('genre', 'isNot', 10764, 'hard')],
);
assert.deepEqual(
  util.groundRules([R('genre', 'is', 18, 'hard')], ['דרמות בלבד']),
  [R('genre', 'is', 18, 'hard')], // stem 'דרמ' grounds the plural
);
assert.deepEqual(
  util.groundRules([R('genre', 'is', 35, 'hard')], ['רק קומדיות']),
  [R('genre', 'is', 35, 'hard')], // stem 'קומד' grounds the plural
);
assert.deepEqual(
  util.groundRules([R('country', 'is', 'IT', 'hard')], ['אוהב סדרות איטלקיות']),
  [R('country', 'is', 'IT', 'soft')], // extended country cues; liking wording stays soft
);
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10767, 'hard')], ['לא אוהב תוכניות יומיות']),
  [R('genre', 'isNot', 10767, 'hard')], // 'יומי' grounds Talk too — daily shows are ambiguous
);
assert.deepEqual(
  util.groundRules([R('status', 'is', 'Ended', 'hard')], ['רק סדרות שנגמרו']),
  [R('status', 'is', 'Ended', 'hard')], // 'נגמר' grounds Ended
);
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10764, 'hard')], ['מעדיף שלא לראות ריאליטי']),
  [R('genre', 'isNot', 10764, 'soft')], // mild wording never keeps hard
);

// --- groundRules: 'בלבד' / 'בלי' / 'without' are categorical (mood probe 17 Nov) ---
assert.deepEqual(
  util.groundRules(
    [R('genre', 'is', 18, 'hard'), R('country', 'is', 'IL', 'hard'), R('genre', 'isNot', 10764, 'hard')],
    ['דרמה ישראלית בלבד, בלי תוכניות ריאליטי'],
  ),
  [R('genre', 'is', 18, 'hard'), R('country', 'is', 'IL', 'hard'), R('genre', 'isNot', 10764, 'hard')],
);
assert.deepEqual(
  util.groundRules([R('genre', 'isNot', 10764, 'hard')], ['Dramas without reality shows']),
  [R('genre', 'isNot', 10764, 'hard')],
);
assert.deepEqual(
  util.groundRules([R('year', 'lte', 1999, 'hard')], ['Only shows before 2000']),
  [R('year', 'lte', 1999, 'hard')],
);
assert.deepEqual(
  util.groundRules(
    [R('year', 'gte', 1990, 'hard'), R('year', 'lte', 1999, 'hard')],
    ['Only shows from the 90s'],
  ),
  [R('year', 'gte', 1990, 'hard'), R('year', 'lte', 1999, 'hard')], // decade wording grounds both bounds
);
assert.deepEqual(
  util.groundRules([R('year', 'gte', 1980, 'hard')], ['Only shows from the 90s']),
  [], // invented year outside the named decade: dropped
);
assert.deepEqual(
  util.groundRules([R('year', 'gte', 2000, 'hard')], ['משנות ה-2000 ואילך']),
  [R('year', 'gte', 2000, 'soft')], // Hebrew decade wording grounds; no categorical marker -> soft
);
assert.deepEqual(
  util.groundRules([R('country', 'isNot', 'US', 'hard')], ['No American shows']),
  [R('country', 'isNot', 'US', 'hard')],
);
assert.deepEqual(
  util.groundRules([R('country', 'is', 'US', 'hard')], ['I love shows because they are great']),
  [], // 'because' contains 'us' but the bare code needs word boundaries
);
assert.deepEqual(
  util.groundRules([R('status', 'is', 'Ended', 'hard')], ['Only finished shows']),
  [R('status', 'is', 'Ended', 'hard')],
);
assert.deepEqual(
  util.groundRules([R('seasons', 'gte', 3, 'soft')], ['I like shows with at least 3 seasons']),
  [R('seasons', 'gte', 3, 'soft')],
);
assert.deepEqual(
  util.groundRules([R('seasons', 'gte', 3, 'hard')], ['I like shows with at least 3 seasons']),
  [R('seasons', 'gte', 3, 'soft')],
);
assert.deepEqual(
  util.groundRules([R('episodeMinutes', 'lte', 30, 'soft')], ['Episodes under 30 minutes']),
  [R('episodeMinutes', 'lte', 30, 'soft')],
);
assert.deepEqual(util.groundRules([R('genre', 'isNot', 10764, 'hard')], []), []);
// Cue coverage: every genre id has grounding cues; News covers current-affairs wording.
for (const g of util.TMDB_TV_GENRES) {
  assert.ok(util.GENRE_GROUNDING_CUES.some((c) => c.name === g.name && c.words.length > 0));
}
assert.ok(util.GENRE_GROUNDING_CUES.find((c) => c.name === 'News').words.includes('אקטואל')); // stem covers אקטואליה/אקטואלי

// --- reservoir: parse/serialize, thresholds, taste equality ---
const mkEntry = (id, extra = {}) => ({
  tmdbId: id,
  score: 0.5,
  rationale: 'r',
  risk: null,
  title: `Show ${id}`,
  originalTitle: `Show ${id}`,
  originalLanguage: 'en',
  originCountry: ['US'],
  genreIds: [35],
  firstAirDate: '2012-01-31',
  popularity: 10,
  voteAverage: 8,
  voteCount: 100,
  posterPath: null,
  detailFacts: { status: 'Ended', seasons: 5, episodeMinutes: 20 },
  ...extra,
});
const reservoirJson = util.serializeReservoirEntries([mkEntry(1), mkEntry(2)]);
assert.deepEqual(util.parseReservoirEntries(reservoirJson), [mkEntry(1), mkEntry(2)]);
assert.deepEqual(util.parseReservoirEntries(''), []);
assert.deepEqual(util.parseReservoirEntries(null), []);
assert.deepEqual(util.parseReservoirEntries('not json'), []);
assert.deepEqual(util.parseReservoirEntries('{"a":1}'), []);
// Legacy pool rows ({tmdbId, score} only) drop out -> rebuild path.
assert.deepEqual(util.parseReservoirEntries('[{"tmdbId":39297,"score":0.97}]'), []);
// Malformed entries dropped, duplicates collapse (first wins), cap 50.
assert.deepEqual(
  util.parseReservoirEntries(
    JSON.stringify([mkEntry(1), { tmdbId: 'x' }, mkEntry(1, { title: 'Dup' }), mkEntry(2, { genreIds: 'nope' }), null]),
  ),
  [mkEntry(1)],
);
const fiftyOne = Array.from({ length: 51 }, (_, i) => mkEntry(100 + i));
assert.equal(util.parseReservoirEntries(JSON.stringify(fiftyOne)).length, 50);
assert.equal(util.serializeReservoirEntries(fiftyOne).length > 0, true);
assert.equal(JSON.parse(util.serializeReservoirEntries(fiftyOne)).length, 50);
// Defaults: missing optional fields coerce, bad detail facts -> nulls.
assert.deepEqual(
  util.parseReservoirEntries(JSON.stringify([{ tmdbId: 7, title: 'X', genreIds: [18] }])),
  [
    {
      tmdbId: 7, score: 0, rationale: '', risk: null, title: 'X', originalTitle: 'X',
      originalLanguage: '', originCountry: [], genreIds: [18], firstAirDate: '',
      popularity: 0, voteAverage: 0, voteCount: 0, posterPath: null,
      detailFacts: { status: null, seasons: null, episodeMinutes: null },
    },
  ],
);
// Facts from a stored entry (no fetch).
assert.deepEqual(util.reservoirEntryFacts(mkEntry(1)), {
  genreIds: [35], year: 2012, originCountry: ['US'], status: 'Ended', seasons: 5, episodeMinutes: 20,
});
assert.deepEqual(util.reservoirEntryFacts(mkEntry(1, { firstAirDate: '' })), {
  genreIds: [35], year: null, originCountry: ['US'], status: 'Ended', seasons: 5, episodeMinutes: 20,
});
// Thresholds: <=10 rebuild, <30 top-up, >=30 re-rank.
assert.equal(util.reservoirPath(0), 'rebuild');
assert.equal(util.reservoirPath(10), 'rebuild');
assert.equal(util.reservoirPath(11), 'topup');
assert.equal(util.reservoirPath(29), 'topup');
assert.equal(util.reservoirPath(30), 'rerank');
assert.equal(util.reservoirPath(50), 'rerank');
assert.equal(util.RESERVOIR_SIZE, 50);
assert.equal(util.RESERVOIR_TOPUP_THRESHOLD, 30);
assert.equal(util.RESERVOIR_REBUILD_THRESHOLD, 10);
assert.equal(util.RESERVOIR_FRESH_BATCH, 10);
// Taste-record equality: trim-insensitive sections, order-insensitive rules.
const recA = { sections: { shared: 'a', casual: 'b', deep: 'c' }, rules: [R('genre', 'isNot', 10764, 'hard'), R('seasons', 'gte', 3, 'soft')] };
assert.equal(util.tasteRecordsEqual(recA, structuredClone(recA)), true);
assert.equal(
  util.tasteRecordsEqual(recA, { sections: { shared: 'a ', casual: 'b', deep: 'c' }, rules: [R('seasons', 'gte', 3, 'soft'), R('genre', 'isNot', 10764, 'hard')] }),
  true,
);
assert.equal(util.tasteRecordsEqual(recA, { ...recA, sections: { ...recA.sections, deep: 'different' } }), false);
assert.equal(util.tasteRecordsEqual(recA, { ...recA, rules: [R('genre', 'isNot', 10764, 'hard')] }), false);
assert.equal(util.tasteRecordsEqual(recA, { ...recA, rules: [R('genre', 'isNot', 10764, 'soft'), R('seasons', 'gte', 3, 'soft')] }), false);

assert.equal(
  util.tasteTextForKind({ shared: 's', casual: 'c', deep: 'd' }, 'casual'),
  's\nc',
);
assert.equal(
  util.tasteTextForKind({ shared: 's', casual: '', deep: 'd' }, 'casual'),
  's',
);
assert.equal(
  util.combineTasteSections({ shared: 's', casual: '', deep: 'd' }),
  's\nd',
);
assert.equal(
  util.formatSectionsForPrompt({ shared: 's', casual: 'c', deep: '' }),
  '[Shared] s\n[Casual] c',
);
assert.equal(util.formatSectionsForPrompt({ shared: '', casual: '', deep: '' }), '');

// detectLanguageConflict
assert.equal(
  util.detectLanguageConflict(['I love Korean dramas'], ['he', 'en']).languageCode,
  'ko',
);
assert.equal(util.detectLanguageConflict(['I love Korean dramas'], ['he', 'en', 'ko']), null);
assert.equal(util.detectLanguageConflict(['The weather is nice'], ['he']), null);
assert.equal(
  util.detectLanguageConflict(['אני אוהבת סדרות קוריאניות'], ['he']).languageCode,
  'ko',
);

// ---------------------------------------------------------------- rerank
// worker/src/rerank.ts: decay, MMR/calibration/epsilon greedy pass,
// rank-pass merging, grounded rationales, negative similarity.
const rerankOutFile = join(root, 'node_modules', '.selftest-rerank.mjs');
await build({
  entryPoints: [join(root, 'worker', 'src', 'rerank.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: rerankOutFile,
  logLevel: 'silent',
});
const rerank = await import(rerankOutFile);
await unlink(rerankOutFile).catch(() => {});

const NOW = Date.UTC(2026, 10, 15);
const DAY = 86_400_000;
// decayWeight: half-life 90 days
assert.equal(rerank.decayWeight(NOW, NOW), 1);
assert.ok(Math.abs(rerank.decayWeight(NOW - 90 * DAY, NOW) - 0.5) < 1e-9);
assert.ok(Math.abs(rerank.decayWeight(NOW - 180 * DAY, NOW) - 0.25) < 1e-9);
assert.ok(Math.abs(rerank.decayWeight(NOW - 365 * DAY, NOW) - 0.0603) < 0.001);
assert.equal(rerank.decayWeight(NOW + 5 * DAY, NOW), 1); // future -> no decay
assert.equal(rerank.TASTE_HALF_LIFE_DAYS, 90);

// buildShortTermTasteText: recent entries only, newest first, floor 0.25
const logRows = [
  { kind: 'show', rating: 'liked', showTitle: 'Old Show', text: 'great', createdAt: NOW - 200 * DAY },
  { kind: 'show', rating: 'liked', showTitle: 'New Show', text: 'funny', createdAt: NOW - 2 * DAY },
  { kind: 'note', rating: 'like', showTitle: null, text: 'love comedies', createdAt: NOW - 10 * DAY },
  { kind: 'show', rating: 'dropped', showTitle: 'Meh Show', text: '', createdAt: NOW - 30 * DAY },
];
const shortText = rerank.buildShortTermTasteText(logRows, NOW);
assert.ok(!shortText.includes('Old Show'), '200-day-old entry below the floor is excluded');
assert.ok(shortText.includes('New Show'));
assert.ok(shortText.indexOf('New Show') < shortText.indexOf('love comedies'));
assert.ok(shortText.includes('[dropped] Meh Show'));
assert.equal(rerank.buildShortTermTasteText(logRows.slice(0, 1), NOW), '');
assert.equal(rerank.buildShortTermTasteText([], NOW), '');

// freshnessFor: new shows 1, old shows 0, unknown neutral
assert.equal(rerank.freshnessFor('2026-03-01', NOW), 1);
assert.equal(rerank.freshnessFor('2025-06-01', NOW), 1);
assert.ok(rerank.freshnessFor('2010-01-01', NOW) < 0.3);
assert.equal(rerank.freshnessFor('2000-01-01', NOW), 0);
assert.equal(rerank.freshnessFor('', NOW), 0.5);

// fitFromRank
assert.equal(rerank.fitFromRank(0, 10), 1);
assert.ok(Math.abs(rerank.fitFromRank(9, 10) - 0.1) < 1e-9);
assert.equal(rerank.fitFromRank(0, 0), 0);

// noveltyFor: identical -> 0, orthogonal -> 1, genre fallback, neutral
assert.equal(rerank.noveltyFor([1, 0], [35], [[1, 0]], [[35]]), 0);
assert.equal(rerank.noveltyFor([1, 0], [35], [[0, 1]], [[18]]), 1);
assert.equal(rerank.noveltyFor(undefined, [35], [], [[35]]), 0);
assert.equal(rerank.noveltyFor(undefined, [35], [], [[18]]), 1);
assert.equal(rerank.noveltyFor(undefined, [35], [], []), 0.5);

// calibrationTargetFromLiked: cluster shares sum to 1
const target = rerank.calibrationTargetFromLiked([[35], [35], [18], [18, 80]]);
assert.ok(Math.abs([...target.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
assert.equal(target.get('comedy'), 0.5);
assert.equal(target.get('drama'), 0.5); // [18,80] clusters as drama
assert.equal(rerank.calibrationTargetFromLiked([]).size, 0);

// deterministicRerank: strict cap, epsilon near-tie swap, MMR split,
// calibration bonus, determinism, capBound reporting
const mkItem = (id, fit, cluster, emb, genreIds) => ({
  tmdbId: id, fit, novelty: 0.5, freshness: 0.5, cluster, embedding: emb, genreIds,
});
// Cap: 5 comedy items, cap 3 -> exactly 3 comedy in the order, capBound
const capItems2 = [
  mkItem(1, 1.0, 'comedy', [1, 0], [35]),
  mkItem(2, 0.9, 'comedy', [1, 0.1], [35]),
  mkItem(3, 0.8, 'comedy', [1, 0.2], [35]),
  mkItem(4, 0.7, 'comedy', [1, 0.3], [35]),
  mkItem(5, 0.6, 'comedy', [1, 0.4], [35]),
  mkItem(6, 0.5, 'drama', [0, 1], [18]),
];
const capped = rerank.deterministicRerank(capItems2, 'casual', new Map(), 3);
assert.equal(capped.ordered.filter((x) => x.cluster === 'comedy').length, 3);
assert.deepEqual(capped.ordered.map((x) => x.tmdbId), [1, 2, 3, 6]);
assert.equal(capped.capBound, true);
// Deferred: the cap-blocked remainder is returned in input order for
// narrow-pool relaxation — never silently dropped.
assert.deepEqual(capped.deferred.map((x) => x.tmdbId), [4, 5]);
// No cap pressure: all items ordered, capBound false
const free = rerank.deterministicRerank(capItems2.slice(0, 3), 'casual', new Map(), 3);
assert.equal(free.ordered.length, 3);
assert.equal(free.capBound, false);
assert.deepEqual(free.deferred, []);
// relaxedDisplay: strict order first, deferred fill only leftover slots
assert.deepEqual(rerank.relaxedDisplay([1, 2, 3, 6], [4, 5], 10), [1, 2, 3, 6, 4, 5]);
assert.deepEqual(rerank.relaxedDisplay([1, 2, 3, 6], [4, 5], 4), [1, 2, 3, 6]); // cap still binds when full
assert.deepEqual(rerank.relaxedDisplay([1, 2], [3, 4, 5], 3), [1, 2, 3]);
assert.deepEqual(rerank.relaxedDisplay([], [3, 4], 10), [3, 4]);
// Epsilon near-tie: item 2 (fit 0.97) beats item 1 (fit 1.0) on
// novelty+freshness because it is within epsilon; item 3 (fit 0.5) cannot leap.
const tieItems = [
  mkItem(1, 1.0, 'drama', [1, 0], [18]),
  { tmdbId: 2, fit: 0.97, novelty: 1, freshness: 1, cluster: 'comedy', embedding: [0, 1], genreIds: [35] },
  { tmdbId: 3, fit: 0.5, novelty: 1, freshness: 1, cluster: 'scifi', embedding: [0, 0.9], genreIds: [10765] },
];
const tied = rerank.deterministicRerank(tieItems, 'casual', new Map(), 3);
assert.equal(tied.ordered[0].tmdbId, 2);
assert.equal(tied.ordered[2].tmdbId, 3);
// MMR: two near-identical top-fit items are split by a diverse item
const mmrItems = [
  mkItem(1, 1.0, 'drama', [1, 0], [18]),
  mkItem(2, 0.99, 'drama', [1, 0.001], [18]),
  mkItem(3, 0.98, 'drama', [0, 1], [18]),
];
const mmr = rerank.deterministicRerank(mmrItems, 'deep', new Map(), 3);
assert.deepEqual(mmr.ordered.map((x) => x.tmdbId), [1, 3, 2]);
// Calibration: with a 100% comedy target, the comedy item wins the
// near-tie over the drama item despite equal fit/novelty/freshness.
const calibItems = [
  mkItem(1, 1.0, 'drama', [1, 0], [18]),
  mkItem(2, 1.0, 'comedy', [0, 1], [35]),
];
const calibTarget = new Map([['comedy', 1]]);
const calib = rerank.deterministicRerank(calibItems, 'casual', calibTarget, 3);
assert.equal(calib.ordered[0].tmdbId, 2);
// Soft rules: with equal fit/novelty/freshness and no calibration
// target, the item satisfying the soft rules (+1) wins over the
// item violating them (-1) by the bounded bonus; without the rules
// field the same input keeps input order (byte-identical behavior
// for rule-less profiles).
const ruleItems = [
  { tmdbId: 1, fit: 1.0, novelty: 0.5, freshness: 0.5, rules: -1, cluster: 'drama', embedding: [1, 0], genreIds: [18] },
  { tmdbId: 2, fit: 1.0, novelty: 0.5, freshness: 0.5, rules: 1, cluster: 'comedy', embedding: [0, 1], genreIds: [35] },
];
const ruled = rerank.deterministicRerank(ruleItems, 'casual', new Map(), 3);
assert.deepEqual(ruled.ordered.map((x) => x.tmdbId), [2, 1]);
const unruled = rerank.deterministicRerank(
  ruleItems.map(({ rules: _r, ...rest }) => rest),
  'casual',
  new Map(),
  3,
);
assert.deepEqual(unruled.ordered.map((x) => x.tmdbId), [1, 2]);
assert.equal(rerank.RULES_BONUS_WEIGHT, 0.1);
// Determinism: same input twice -> same order
const again = rerank.deterministicRerank(mmrItems, 'deep', new Map(), 3);
assert.deepEqual(again.ordered.map((x) => x.tmdbId), mmr.ordered.map((x) => x.tmdbId));

// maxNegativeSimilarity / thresholds
assert.equal(rerank.maxNegativeSimilarity([1, 0], [[1, 0]]), 1);
assert.equal(rerank.maxNegativeSimilarity([1, 0], [[0, 1]]), 0);
assert.equal(rerank.maxNegativeSimilarity(undefined, [[1, 0]]), 0);
assert.equal(rerank.maxNegativeSimilarity([1, 0], []), 0);
assert.equal(rerank.NEGATIVE_EXCLUSION_COSINE, 0.92);
assert.equal(rerank.NEGATIVE_DEMOTION_COSINE, 0.85);

// mergeRankPasses: identical passes keep order; reversed second pass
// averages out; one-pass-only items sink; rationale from better rank
const e = (id, rationale) => ({ tmdbId: id, rationale, risk: null });
const m1 = rerank.mergeRankPasses([e(1, 'a'), e(2, 'b'), e(3, 'c')], [e(1, 'a2'), e(2, 'b2'), e(3, 'c2')]);
assert.deepEqual(m1.map((x) => x.tmdbId), [1, 2, 3]);
assert.equal(m1[0].rationale, 'a'); // tie -> first pass
const m2 = rerank.mergeRankPasses(
  [e(1, 'a'), e(2, 'b'), e(3, 'c'), e(4, 'd')],
  [e(3, 'c2'), e(2, 'b2'), e(1, 'a2')],
);
// Mean normalized ranks: 3 (0.25), 2 (0.29), 1 (0.33), 4 (0.875, one pass only).
assert.deepEqual(m2.map((x) => x.tmdbId), [3, 2, 1, 4]);
assert.equal(m2[0].rationale, 'c2'); // 3 ranked better in pass 2
assert.equal(m2[1].rationale, 'b'); // 2 ranked better in pass 1 (0.25 < 0.33)
const m3 = rerank.mergeRankPasses([e(1, 'a'), e(2, 'b')], [e(2, 'b2'), e(3, 'c2')]);
assert.deepEqual(m3.map((x) => x.tmdbId), [2, 1, 3]); // 3 penalized (one pass only)
assert.equal(m3[0].rationale, 'b2'); // 2 ranked better in pass 2
assert.deepEqual(rerank.mergeRankPasses([], []), []);

// bestGenreOverlapAnchor: >= 2 shared genres, ties keep earliest
assert.equal(rerank.bestGenreOverlapAnchor([16, 35], [[35], [18, 35]]), -1); // single-genre overlap is too weak
assert.equal(rerank.bestGenreOverlapAnchor([16, 35], [[16, 35], [35]]), 0);
assert.equal(rerank.bestGenreOverlapAnchor([80, 18, 9648], [[18], [80, 18], [80, 18, 9648]]), 2);
assert.equal(rerank.bestGenreOverlapAnchor([80, 18], [[80, 18], [80, 18, 9648]]), 0); // tie -> earliest
assert.equal(rerank.bestGenreOverlapAnchor([], [[35]]), -1);
assert.equal(rerank.bestGenreOverlapAnchor([35], []), -1);

// bestKindScopedAnchor: same-kind liked shows win over cross-kind
// ones, even at lower overlap; fallback to any liked show only when
// no same-kind show qualifies. Kinds computed via classifyKind so the
// test premises match production behavior.
const kindsOf = (sets) => sets.map((s) => util.classifyKind(s));
// Deep candidate; cross-kind casual show overlaps MORE (3) than the
// same-kind deep show (2) — same-kind still wins.
const scopedSetsA = [[35, 10751, 10762, 10764, 80, 18, 9648], [80, 18]];
assert.deepEqual(kindsOf(scopedSetsA), ['casual', 'deep']);
assert.equal(rerank.bestKindScopedAnchor([80, 18, 9648, 10765], scopedSetsA, kindsOf(scopedSetsA), 'deep'), 1);
// Casual candidate; same-kind casual show wins over a higher-overlap deep show.
const scopedSetsB = [[35, 10751, 10762, 80, 18, 9648], [35, 10762]];
assert.deepEqual(kindsOf(scopedSetsB), ['deep', 'casual']);
assert.equal(rerank.bestKindScopedAnchor([35, 10751, 10762], scopedSetsB, kindsOf(scopedSetsB), 'casual'), 1);
// Fallback: no same-kind show qualifies -> cross-kind show is used.
const scopedSetsC = [[35, 10751, 10762, 80, 18]];
assert.deepEqual(kindsOf(scopedSetsC), ['casual']);
assert.equal(rerank.bestKindScopedAnchor([80, 18], scopedSetsC, kindsOf(scopedSetsC), 'deep'), 0);
// Same-kind show with only 1 shared genre does not block the fallback.
const scopedSetsD = [[80], [35, 10751, 10762, 18, 9648]];
assert.deepEqual(kindsOf(scopedSetsD), ['deep', 'casual']);
assert.equal(rerank.bestKindScopedAnchor([80, 18, 9648], scopedSetsD, kindsOf(scopedSetsD), 'deep'), 1);
// Nothing qualifies -> -1; ties within same-kind keep earliest.
assert.equal(rerank.bestKindScopedAnchor([80, 18], [[35]], ['casual'], 'deep'), -1);
assert.equal(rerank.bestKindScopedAnchor([80, 18], [[80, 18], [80, 18, 9648]], ['deep', 'deep'], 'deep'), 0);

// groundRationale / templateRationale
assert.equal(
  rerank.groundRationale('Loved it because Seinfeld fans enjoy this.', 'Seinfeld', ['Comedy'], '1994', 'en'),
  'Loved it because Seinfeld fans enjoy this.',
);
assert.equal(
  rerank.groundRationale('A funny show from 1994 with great comedy.', 'Seinfeld', ['Comedy'], '1994', 'en'),
  'A funny show from 1994 with great comedy.', // genre + year cited
);
assert.equal(
  rerank.groundRationale('An amazing show you will love.', 'Seinfeld', ['Comedy'], '1994', 'en'),
  'Similar to Seinfeld (Comedy, 1994).',
);
assert.equal(rerank.groundRationale('', 'Seinfeld', ['Comedy'], '1994', 'en'), 'Similar to Seinfeld (Comedy, 1994).');
assert.equal(rerank.groundRationale('Great show.', null, ['Drama'], '2021', 'en'), 'Matches your taste (Drama, 2021).');
assert.equal(rerank.groundRationale('', null, [], '', 'en'), 'Matches your taste profile.');
assert.equal(
  rerank.groundRationale('סדרה נהדרת.', 'סיינפלד', ['קומדיה'], '1994', 'he'),
  'דומה לסיינפלד (קומדיה, 1994).',
);
assert.equal(
  rerank.groundRationale('מזכיר את סיינפלד בקצב.', 'סיינפלד', ['קומדיה'], '1994', 'he'),
  'מזכיר את סיינפלד בקצב.',
);

// parseRemovalCheckResponse: validates ids, dedupes, fails open
assert.deepEqual(util.parseRemovalCheckResponse('{"removeIds": [1, 2]}', new Set([1, 2, 3])), [1, 2]);
assert.deepEqual(util.parseRemovalCheckResponse('{"removeIds": [1, 999, 1]}', new Set([1, 2])), [1]);
assert.deepEqual(util.parseRemovalCheckResponse('{"removeIds": []}', new Set([1])), []);
assert.deepEqual(util.parseRemovalCheckResponse('not json', new Set([1])), []);
assert.deepEqual(util.parseRemovalCheckResponse('{"removeIds": "nope"}', new Set([1])), []);
assert.deepEqual(util.parseRemovalCheckResponse('prefix {"removeIds": ["2"]} suffix', new Set([2])), [2]);

// parseRankResponse: invented/duplicate/string ids (hygiene hardening)
const rankDup = util.parseRankResponse(
  '{"ranked": [{"tmdbId": "1", "rationale": "a"}, {"tmdbId": 1, "rationale": "b"}, {"tmdbId": 7, "rationale": "c"}]}',
  new Set([1, 2]),
);
assert.deepEqual(rankDup.ranked.map((r) => r.tmdbId), [1]);
assert.equal(rankDup.ranked[0].rationale, 'a');

// ---------------------------------------------------------------- mock LLM provider + selection
// Bundles llm.ts (which pulls in mockLlm.ts + util.ts) and embeddings.ts.

async function bundleModule(name, entry) {
  const file = join(root, 'node_modules', `.selftest-${name}.mjs`);
  await build({
    entryPoints: [join(root, 'worker', 'src', entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: file,
    logLevel: 'silent',
  });
  const mod = await import(file);
  await unlink(file).catch(() => {});
  return mod;
}

const llm = await bundleModule('llm', 'llm.ts');
const mockLlm = await bundleModule('mock', 'mockLlm.ts');
const rules = await bundleModule('rules', 'rules.ts');
const embeddings = await bundleModule('embed', 'embeddings.ts');

const fakeAi = { run: async () => { throw new Error('real AI must not be called in selftest'); } };

// --- mock determinism + shapes (all four call sites) ---

const consolNotes = [
  { kind: 'liked', source: 'rating', text: 'Fauda', createdAt: 1 },
  { kind: 'disliked', source: 'rating', text: 'The Office: too cringe', createdAt: 2 },
  { kind: 'note', source: 'note', text: 'Something light for casual evenings', createdAt: 3 },
  { kind: 'note', source: 'note', text: 'I want deep immersive stories that demand concentration', createdAt: 4 },
  { kind: 'note', source: 'note', text: 'No horror', createdAt: 5 },
];
const consolReq = llm.buildConsolidationPrompt(consolNotes, 'en', null, ['he', 'en']);
const mockProvider = new mockLlm.MockLlmProvider();
assert.equal(mockProvider.name, 'mock');
const consolOut1 = await mockProvider.generate(consolReq);
const consolOut2 = await mockProvider.generate(consolReq);
assert.equal(consolOut1, consolOut2); // deterministic
const consolParsed = util.parseConsolidationResponse(consolOut1);
assert.ok(consolParsed.sections.shared.includes('too cringe')); // rating reason -> Shared, title stripped
assert.ok(!consolParsed.sections.shared.includes('Fauda')); // bare title: no free text, dropped
assert.ok(!consolParsed.sections.shared.includes('The Office')); // show names never surface in the summary
assert.ok(consolParsed.sections.shared.includes('No horror')); // ambiguous -> Shared
assert.ok(consolParsed.sections.casual.includes('light')); // casual cue routes
assert.ok(consolParsed.sections.deep.includes('immersive')); // deep cue routes
assert.deepEqual(consolParsed.contradictions, []);
assert.equal(consolParsed.languageConflict, null);
assert.deepEqual(consolParsed.rules, []); // 'No horror' is unmappable: no rule

// --- consolidation temperature + input fingerprint (deferred consolidation) ---
assert.equal(consolReq.temperature, 0); // greedy: re-runs reproduce the record

const fbRows = [
  { id: '1', kind: 'show', tmdbId: 1, showTitle: 'Fauda', rating: 'liked', text: '', originalLanguage: 'he', createdAt: 1 },
  { id: '2', kind: 'show', tmdbId: 2, showTitle: 'The Office', rating: 'disliked', text: 'too cringe', originalLanguage: 'en', createdAt: 2 },
  { id: '3', kind: 'note', tmdbId: null, showTitle: null, rating: 'note', text: 'Something light', originalLanguage: null, createdAt: 3 },
  { id: '4', kind: 'note', tmdbId: null, showTitle: null, rating: 'note', text: '   ', originalLanguage: null, createdAt: 4 },
  { id: '5', kind: 'show', tmdbId: 3, showTitle: null, rating: 'liked', text: '', originalLanguage: null, createdAt: 5 },
];
assert.deepEqual(llm.buildConsolidationNotes(fbRows), [
  { kind: 'disliked', source: 'rating', text: 'The Office: too cringe', createdAt: 2 },
  { kind: 'note', source: 'note', text: 'Something light', createdAt: 3 },
]); // TEXT ONLY: bare rating (Fauda) excluded — ratings feed embeddings, not consolidation; text-less note + title-less/text-less rating skipped; reason glued to title

const fpNotes = llm.buildConsolidationNotes(fbRows);
const fp1 = llm.consolidationInputFingerprint(fpNotes, 'workers-ai:llama-3.3-70b');
assert.equal(llm.consolidationInputFingerprint(fpNotes, 'workers-ai:llama-3.3-70b'), fp1); // deterministic
assert.notEqual(
  llm.consolidationInputFingerprint([...fpNotes, { kind: 'note', source: 'note', text: 'More drama', createdAt: 6 }], 'workers-ai:llama-3.3-70b'),
  fp1,
); // a new note changes the input
assert.notEqual(llm.consolidationInputFingerprint(fpNotes, 'mock'), fp1); // model identity is part of the input
assert.equal(
  llm.consolidationInputFingerprint(fpNotes.map((n) => ({ ...n, createdAt: n.createdAt + 1000 })), 'workers-ai:llama-3.3-70b'),
  fp1,
); // timestamps are not input
assert.equal(llm.CONSOLIDATION_INPUT_VERSION, 2); // v2: text-only input + show-name output ban

// --- mock Hebrew cue routing (dev-only simulation fidelity) ---
// Eyal's exact dev-profile sentences route to the right sections when
// each is its own note (the mock routes per statement line, as the
// consolidation prompt renders one line per feedback entry).
assert.equal(mockLlm.routeNote('אוהב סדרות קומיות קצרות.'), 'casual');
assert.equal(mockLlm.routeNote('לצפייה משמעותית אוהב אקשן ומתח.'), 'deep');
// Ambiguous notes still default to Shared.
assert.equal(mockLlm.routeNote('אוהב סדרות ישראליות.'), 'shared');
assert.equal(mockLlm.routeNote('No horror, please.'), 'shared');
// More cue coverage, both languages; casual wins on a mixed line
// (documented first-match order, unchanged).
assert.equal(mockLlm.routeNote('Something funny and short'), 'casual');
assert.equal(mockLlm.routeNote('A tense thriller with a complex plot'), 'deep');
assert.equal(mockLlm.routeNote('סדרת פשע מותחת ורצינית'), 'deep');
assert.equal(mockLlm.routeNote('משהו מצחיק וקליל ברקע'), 'casual');
assert.equal(mockLlm.routeNote('light comedy but also deep drama'), 'casual');
// End-to-end through the real prompt builder: his two sentences as two
// notes populate Casual and Deep, and an ambiguous note stays Shared.
const hebrewNotes = [
  { kind: 'note', source: 'note', text: 'אוהב סדרות קומיות קצרות.', createdAt: 1 },
  { kind: 'note', source: 'note', text: 'לצפייה משמעותית אוהב אקשן ומתח.', createdAt: 2 },
  { kind: 'note', source: 'note', text: 'אוהב סדרות ישראליות.', createdAt: 3 },
];
const hebrewReq = llm.buildConsolidationPrompt(hebrewNotes, 'he', null, ['he', 'en']);
const hebrewParsed = util.parseConsolidationResponse(await mockProvider.generate(hebrewReq));
assert.ok(hebrewParsed.sections.casual.includes('קומיות'));
assert.ok(hebrewParsed.sections.deep.includes('אקשן'));
assert.ok(hebrewParsed.sections.shared.includes('ישראליות'));

// --- mock rule extraction (dev-only simulation fidelity) ---
const MR = (dimension, operator, value, mode) => ({ dimension, operator, value, mode });
assert.deepEqual(mockLlm.extractMockRules(['I never watch reality shows']), [
  MR('genre', 'isNot', 10764, 'hard'),
]);
assert.deepEqual(mockLlm.extractMockRules(['לא אוהב ריאלטי, תוכניות אירוח, ותוכניות מוזיקליות']), [
  MR('genre', 'isNot', 10764, 'hard'),
  MR('genre', 'isNot', 10767, 'hard'), // musicals unmappable: dropped
]);
assert.deepEqual(mockLlm.extractMockRules(['I prefer less comedy']), [
  MR('genre', 'isNot', 35, 'soft'), // mild wording: soft rule, never hard
]);
assert.deepEqual(mockLlm.extractMockRules(['No horror, please.']), []); // horror has no TV genre
assert.deepEqual(mockLlm.extractMockRules(['Nothing before 2000']), [MR('year', 'gte', 2000, 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['Shows from 2010 onwards only']), [MR('year', 'gte', 2010, 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['Only shows before 2000']), [MR('year', 'lte', 1999, 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['Nothing after 2010']), [MR('year', 'lte', 2010, 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['Shows before 2000']), []); // bare "before" is ambiguous: omitted
assert.deepEqual(mockLlm.extractMockRules(['I prefer shows after 2010']), [MR('year', 'gte', 2011, 'soft')]);
assert.deepEqual(mockLlm.extractMockRules(['I love comedies']), [MR('genre', 'is', 35, 'soft')]);
assert.deepEqual(mockLlm.extractMockRules(['I only watch comedies']), [MR('genre', 'is', 35, 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['I must avoid comedies']), [MR('genre', 'isNot', 35, 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['No comedies, only drama']), [
  MR('genre', 'isNot', 35, 'hard'),
  MR('genre', 'is', 18, 'hard'),
]);
assert.deepEqual(mockLlm.extractMockRules(['No American shows']), [MR('country', 'isNot', 'US', 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['I love Korean dramas']), [
  MR('genre', 'is', 18, 'soft'),
  MR('country', 'is', 'KR', 'soft'),
]);
assert.deepEqual(mockLlm.extractMockRules(['Only finished shows']), [MR('status', 'is', 'Ended', 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['No ongoing shows']), [
  MR('status', 'isNot', 'Returning Series', 'hard'),
  MR('status', 'isNot', 'In Production', 'hard'),
]);
assert.deepEqual(mockLlm.extractMockRules(['I like shows with at least 3 seasons']), [
  MR('seasons', 'gte', 3, 'soft'),
]);
assert.deepEqual(mockLlm.extractMockRules(['Never more than 2 seasons']), [MR('seasons', 'lte', 2, 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['Episodes under 30 minutes, please']), [
  MR('episodeMinutes', 'lte', 30, 'soft'),
]);
// Eyal's real Hebrew note: a soft comedy rule + a soft seasons rule.
assert.deepEqual(mockLlm.extractMockRules(['אוהב סדרות קומיות קצרות וקלילות, עם לפחות 3 עונות']), [
  MR('genre', 'is', 35, 'soft'),
  MR('seasons', 'gte', 3, 'soft'),
]);
// Unified vocabulary + post-cue inclusion: bare-cue statements now
// emit rules, mild wording flips the operator, and a post-cue modal
// ("only", "בלבד") includes instead of excluding.
assert.deepEqual(mockLlm.extractMockRules(['בא לי דרמה']), [MR('genre', 'is', 18, 'soft')]);
assert.deepEqual(mockLlm.extractMockRules(['I want comedies']), [MR('genre', 'is', 35, 'soft')]);
assert.deepEqual(mockLlm.extractMockRules(['מעדיף לא ריאליטי']), [
  MR('genre', 'isNot', 10764, 'soft'), // mild: negated operator, soft
]);
assert.deepEqual(mockLlm.extractMockRules(['comedies only']), [MR('genre', 'is', 35, 'hard')]);
assert.deepEqual(mockLlm.extractMockRules(['דרמה ישראלית בלבד, בלי תוכניות ריאליטי']), [
  MR('genre', 'is', 18, 'hard'),
  MR('genre', 'isNot', 10764, 'hard'),
  MR('country', 'is', 'IL', 'hard'),
]);
assert.deepEqual(mockLlm.extractMockRules(['I love Italian dramas']), [
  MR('genre', 'is', 18, 'soft'),
  MR('country', 'is', 'IT', 'soft'),
]);
assert.deepEqual(mockLlm.extractMockRules(['לא אוהב תוכניות יומיות']), [
  MR('genre', 'isNot', 10763, 'hard'),
  MR('genre', 'isNot', 10767, 'hard'),
]);
// End-to-end through the real prompt builder + mock provider + parser:
// the prompt carries the fixed list, the mock emits the rule, the
// parser validates it — and the 'THREE sections' mock-detection
// marker survives the prompt change.
const exclReq = llm.buildConsolidationPrompt(
  [{ kind: 'note', source: 'note', text: 'I never watch reality shows', createdAt: 1 }],
  'en',
  null,
  ['en'],
);
assert.ok(exclReq.system.includes('THREE sections'));
assert.ok(exclReq.system.includes('10764=Reality'));
assert.ok(exclReq.system.includes('RULES'));
assert.ok(exclReq.system.includes('Returning Series'));
assert.ok(exclReq.system.includes('EXPLICITLY named')); // anti-inference clause: no invented categories
const exclParsed = util.parseConsolidationResponse(await mockProvider.generate(exclReq));
assert.deepEqual(exclParsed.rules, [MR('genre', 'isNot', 10764, 'hard')]);

const rankCands = [
  { tmdbId: 11, title: 'Alpha Show', year: '2020', genres: ['Comedy'], originalLanguage: 'en', originCountry: ['US'], anchorTitle: 'Seinfeld' },
  { tmdbId: 22, title: 'Beta Drama', year: '2021', genres: ['Drama'], originalLanguage: 'en', originCountry: ['US'] },
  { tmdbId: 33, title: 'Gamma Toon', year: '2019', genres: ['Animation', 'Comedy'], originalLanguage: 'en', originCountry: ['US'], anchorTitle: 'The Simpsons' },
];
const rankReq = llm.buildRankPrompt('Love comedies, no horror.', 'casual', rankCands, 'en');
// Kind-fit instruction (classification fix): present in BOTH kinds'
// prompts, kind-specific, with variety + grounding rules intact.
assert.ok(rankReq.system.includes('KIND FIT'));
assert.ok(rankReq.system.includes('CASUAL list'));
assert.ok(rankReq.system.includes('OMIT shows that demand sustained attention'));
assert.ok(rankReq.system.includes('Balance variety'));
assert.ok(rankReq.system.includes('GROUNDING'));
const rankReqDeep = llm.buildRankPrompt('Love dramas.', 'deep', rankCands, 'en');
assert.ok(rankReqDeep.system.includes('KIND FIT'));
assert.ok(rankReqDeep.system.includes('DEEP-FOCUS list'));
assert.ok(rankReqDeep.system.includes('OMIT shows that are light, episodic, dip-in viewing'));
assert.ok(rankReqDeep.system.includes('Balance variety'));
assert.ok(rankReqDeep.system.includes('GROUNDING'));
const rankOut1 = await mockProvider.generate(rankReq);
const rankOut2 = await mockProvider.generate(rankReq);
assert.equal(rankOut1, rankOut2);
const rankParsed = util.parseRankResponse(rankOut1, new Set([11, 22, 33]));
assert.ok(rankParsed);
assert.equal(rankParsed.ranked.length, 3);
assert.deepEqual(new Set(rankParsed.ranked.map((r) => r.tmdbId)), new Set([11, 22, 33]));
// Order is input-order independent: reversed candidates -> same order (dual-pass merge converges).
const rankReqRev = llm.buildRankPrompt('Love comedies, no horror.', 'casual', [...rankCands].reverse(), 'en');
const rankParsedRev = util.parseRankResponse(await mockProvider.generate(rankReqRev), new Set([11, 22, 33]));
assert.deepEqual(rankParsedRev.ranked.map((r) => r.tmdbId), rankParsed.ranked.map((r) => r.tmdbId));
// Rationales cite the anchor (grounding keeps them) or genre+year.
const alpha = rankParsed.ranked.find((r) => r.tmdbId === 11);
assert.ok(alpha.rationale.includes('Seinfeld'));
const beta = rankParsed.ranked.find((r) => r.tmdbId === 22);
assert.ok(beta.rationale.includes('Drama') && beta.rationale.includes('2021'));

const removalReq = llm.buildRemovalCheckPrompt(
  [{ title: 'Bad Show', year: '2020', genres: ['Horror'] }],
  rankCands,
  'en',
);
const removalOut = await mockProvider.generate(removalReq);
assert.deepEqual(util.parseRemovalCheckResponse(removalOut, new Set([11, 22, 33])), []);

// --- mood rule extraction: prompt marker + mock extraction + parser ---
const moodReq = llm.buildMoodExtractionPrompt('I want to see an Israeli drama series');
assert.ok(moodReq.system.includes('MOOD RULE EXTRACTION'));
assert.equal(moodReq.user, 'I want to see an Israeli drama series');
const moodOut = await mockProvider.generate(moodReq);
assert.ok(!moodOut.includes('unrecognized prompt'), 'mock handles the mood prompt');
assert.equal(moodOut, await mockProvider.generate(moodReq), 'mock extraction is deterministic');
const moodRules = rules.parseRulesJson(moodOut);
assert.ok(Array.isArray(moodRules));
assert.deepEqual(
  rules.parseRulesJson('{"rules": [{"dimension": "genre", "operator": "is", "value": 18, "mode": "hard"}]}'),
  [{ dimension: 'genre', operator: 'is', value: 18, mode: 'hard' }],
);
assert.deepEqual(rules.parseRulesJson('```json\n{"rules": []}\n```'), []);
assert.deepEqual(rules.parseRulesJson('not json at all'), []);
assert.deepEqual(rules.parseRulesJson('{"rules": [{"dimension": "genre", "operator": "is", "value": 999}]}'), []);

// --- unified extraction: one RULES spec, one service, both paths ---
// Both prompts embed the SAME fragment: the shared MODE line and the
// shared vocabulary render in each (a synonym added to the vocabulary
// reaches both extractions — the drift that caused the 'בלבד' gap).
for (const [name, system] of [
  ['consolidation', consolReq.system],
  ['mood', moodReq.system],
]) {
  assert.ok(system.includes('MODE — hard ONLY'), `${name} prompt embeds the shared RULES fragment`);
  assert.ok(system.includes('בלבד'), `${name} prompt renders the shared categorical list`);
  assert.ok(system.includes('without'), `${name} prompt renders the shared categorical list`);
  assert.ok(system.includes('10764=Reality'), `${name} prompt renders the shared genre list`);
}
// resolveRules = validate + ground in one step, for both paths.
assert.deepEqual(
  rules.resolveRules(
    [
      { dimension: 'genre', operator: 'isNot', value: 10764, mode: 'hard' },
      { dimension: 'genre', operator: 'is', value: 999, mode: 'hard' },
    ],
    ['I never watch reality shows'],
  ),
  [{ dimension: 'genre', operator: 'isNot', value: 10764, mode: 'hard' }],
);
// Cross-path parity: the same statement through the mood path
// (prompt + mock + service parser + grounding) yields the same rules
// as the extractor directly — one service, both paths. This is the
// dev equivalent of the 17 Nov live probe that exposed the gap.
const probeText = 'דרמה ישראלית בלבד, בלי תוכניות ריאליטי';
const probeReq = llm.buildMoodExtractionPrompt(probeText);
const probeRules = rules.resolveRules(rules.parseRulesJson(await mockProvider.generate(probeReq)), [probeText]);
assert.deepEqual(probeRules, mockLlm.extractMockRules([probeText]));
assert.deepEqual(probeRules, [
  { dimension: 'genre', operator: 'is', value: 18, mode: 'hard' },
  { dimension: 'genre', operator: 'isNot', value: 10764, mode: 'hard' },
  { dimension: 'country', operator: 'is', value: 'IL', mode: 'hard' },
]);

// --- mock embeddings: deterministic, normalized, hash-derived ---
assert.equal(mockLlm.MOCK_EMBEDDING_DIM, 64);
const vecA1 = mockLlm.mockEmbedTexts(['hello world', 'other text']);
const vecA2 = mockLlm.mockEmbedTexts(['hello world', 'other text']);
assert.deepEqual(vecA1, vecA2);
assert.equal(vecA1[0].length, 64);
const norm = Math.sqrt(vecA1[0].reduce((s, v) => s + v * v, 0));
assert.ok(Math.abs(norm - 1) < 1e-9);
assert.ok(Math.abs(util.cosine(vecA1[0], vecA1[0]) - 1) < 1e-9);
assert.ok(Math.abs(util.cosine(vecA1[0], vecA1[1])) < 0.9);
assert.deepEqual(mockLlm.mockEmbedTexts(['']), [new Array(64).fill(0)]);

// --- provider selection: default is real; mock needs the env flag; no override path ---

assert.equal(llm.DEFAULT_CHAT_MODEL, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
assert.equal(embeddings.DEFAULT_EMBED_MODEL, '@cf/baai/bge-m3');
assert.equal(embeddings.resolveEmbedModel({}), '@cf/baai/bge-m3');
assert.equal(embeddings.resolveEmbedModel({ EMBEDDING_MODEL: 'custom-embed' }), 'custom-embed');

assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi }), { kind: 'real', model: llm.DEFAULT_CHAT_MODEL });
assert.equal(llm.getLlmProvider({ AI: fakeAi }).name, 'workers-ai:llama-3.3-70b');
assert.deepEqual(
  llm.resolveLlmMode({ AI: fakeAi, LLM_MODEL: 'custom-model' }),
  { kind: 'real', model: 'custom-model' },
);
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, LLM_PROVIDER: 'mock' }), { kind: 'mock' });
assert.equal(llm.getLlmProvider({ AI: fakeAi, LLM_PROVIDER: 'mock' }).name, 'mock');
assert.deepEqual(llm.resolveLlmMode({}), { kind: 'stub' });
assert.equal(llm.getLlmProvider({}).name, 'stub');
// Mock works without an AI binding (local runs); stub still blocks.
assert.deepEqual(llm.resolveLlmMode({ LLM_PROVIDER: 'mock' }), { kind: 'mock' });

// There is deliberately NO per-request override path (removed by
// decision, 19:15 IST): the decision is a pure function of env. The
// dev flag alone never engages the mock, and no extra env field can
// switch the provider — only LLM_PROVIDER=mock does.
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'true' }), { kind: 'real', model: llm.DEFAULT_CHAT_MODEL });
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'true', LLM_PROVIDER: 'mock' }), { kind: 'mock' });
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'false' }), { kind: 'real', model: llm.DEFAULT_CHAT_MODEL });
assert.equal(llm.isDevWorker({ IS_DEV_WORKER: 'true' }), true);
assert.equal(llm.isDevWorker({}), false);
assert.equal(llm.isDevWorker({ IS_DEV_WORKER: '1' }), false);

// --- split model (2026-11-17): consolidation on LLM_MODEL/70B, ranking on LLM_RANK_MODEL ---
assert.equal(llm.resolveRankModel({ AI: fakeAi }), llm.DEFAULT_CHAT_MODEL);
assert.equal(llm.getRankLlmProvider({ AI: fakeAi }).name, 'workers-ai:llama-3.3-70b');
assert.equal(
  llm.resolveRankModel({ AI: fakeAi, LLM_MODEL: 'custom-model' }),
  'custom-model',
);
assert.equal(
  llm.getRankLlmProvider({ AI: fakeAi, LLM_MODEL: 'custom-model' }).name,
  'workers-ai:custom-model',
);
assert.equal(
  llm.resolveRankModel({ AI: fakeAi, LLM_RANK_MODEL: 'rank-model' }),
  'rank-model',
);
assert.equal(
  llm.getRankLlmProvider({ AI: fakeAi, LLM_RANK_MODEL: 'rank-model' }).name,
  'workers-ai:rank-model',
);
// The rank override never moves consolidation off its own model.
assert.equal(
  llm.getLlmProvider({ AI: fakeAi, LLM_RANK_MODEL: 'rank-model' }).name,
  'workers-ai:llama-3.3-70b',
);
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, LLM_RANK_MODEL: 'rank-model' }), {
  kind: 'real',
  model: llm.DEFAULT_CHAT_MODEL,
});
// Rank override wins over the LLM_MODEL override for ranking only.
assert.equal(
  llm.getRankLlmProvider({ AI: fakeAi, LLM_MODEL: 'custom-model', LLM_RANK_MODEL: 'rank-model' }).name,
  'workers-ai:rank-model',
);
// Mock/stub: no real model to resolve, same provider behavior as consolidation.
assert.equal(llm.resolveRankModel({ AI: fakeAi, LLM_PROVIDER: 'mock' }), null);
assert.equal(llm.getRankLlmProvider({ AI: fakeAi, LLM_PROVIDER: 'mock' }).name, 'mock');
assert.equal(llm.resolveRankModel({}), null);
assert.equal(llm.getRankLlmProvider({}).name, 'stub');

// --- embedTextsWithEnv: mock returns vectors without touching AI; real path uses the model override ---
const mockVecs = await embeddings.embedTextsWithEnv({ LLM_PROVIDER: 'mock', AI: fakeAi }, ['a', 'b']);
assert.equal(mockVecs.length, 2);
assert.equal(mockVecs[0].length, 64);
assert.equal(await embeddings.embedTextsWithEnv({}, ['a']), null);
assert.deepEqual(await embeddings.embedTextsWithEnv({ AI: fakeAi }, []), []);
const embedCalls = [];
const recordingAi = {
  run: async (model, input) => {
    embedCalls.push(model);
    return { data: input.text.map(() => [0.5, 0.5]) };
  },
};
const realVecs = await embeddings.embedTextsWithEnv({ AI: recordingAi, EMBEDDING_MODEL: 'emb-x' }, ['a']);
assert.deepEqual(realVecs, [[0.5, 0.5]]);
assert.deepEqual(embedCalls, ['emb-x']);

// ---------------------------------------------------------------- cast normalization (tmdb.ts)

const tmdb = await bundleModule('tmdb', 'tmdb.ts');

assert.equal(tmdb.MAX_CAST_MEMBERS, 12);
assert.equal(tmdb.creditsCacheLanguage('he'), 'credits:he-IL');
assert.equal(tmdb.creditsCacheLanguage('en'), 'credits:en-US');

const castRaw = [
  { id: 3, name: 'Third Billed', character: 'C', profile_path: null, order: 2 },
  { id: 1, name: 'Top Billed', character: 'A', profile_path: '/p1.jpg', order: 0 },
  { id: 2, name: 'Second', character: '', profile_path: '/p2.jpg', order: 1 },
];
assert.deepEqual(tmdb.toCastMembers(castRaw), [
  { tmdbId: 1, name: 'Top Billed', character: 'A', profilePath: '/p1.jpg' },
  { tmdbId: 2, name: 'Second', character: '', profilePath: '/p2.jpg' },
  { tmdbId: 3, name: 'Third Billed', character: 'C', profilePath: null },
]);
// Cap: 20 billed members -> 12, in billing order.
const many = Array.from({ length: 20 }, (_, i) => ({
  id: 100 + i, name: `Actor ${i}`, character: `Role ${i}`, profile_path: null, order: i,
}));
const cappedCast = tmdb.toCastMembers(many);
assert.equal(cappedCast.length, 12);
assert.equal(cappedCast[0].tmdbId, 100);
assert.equal(cappedCast[11].tmdbId, 111);
// Malformed entries are skipped, never fatal.
assert.deepEqual(tmdb.toCastMembers(null), []);
assert.deepEqual(tmdb.toCastMembers(undefined), []);
assert.deepEqual(
  tmdb.toCastMembers([
    null,
    { id: 'x', name: 'Bad Id', character: '', profile_path: null, order: 0 },
    { id: 7, name: '', character: '', profile_path: null, order: 0 },
    { id: 8, name: 'Good', character: undefined, profile_path: null, order: 0 },
  ]),
  [{ tmdbId: 8, name: 'Good', character: '', profilePath: null }],
);

// ---------------------------------------------------------------- toast list (src/toastList.ts)

const toastOutFile = join(root, 'node_modules', '.selftest-toast.mjs');
await build({
  entryPoints: [join(root, 'src', 'toastList.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: toastOutFile,
  logLevel: 'silent',
});
const toastList = await import(toastOutFile);
await unlink(toastOutFile).catch(() => {});

let toasts = [];
toasts = toastList.addToast(toasts, { message: 'first' }, 'a');
toasts = toastList.addToast(toasts, { message: 'second', kind: 'success' }, 'b');
assert.equal(toasts.length, 2);
assert.equal(toasts[0].kind, 'info');
assert.equal(toasts[1].kind, 'success');
// Keyed replace: same key replaces in place, no duplicate.
toasts = toastList.addToast(toasts, { message: 'replaced', key: 'k1' }, 'x');
toasts = toastList.addToast(toasts, { message: 'replacement', key: 'k1', kind: 'error' }, 'y');
assert.equal(toasts.length, 3);
assert.equal(toasts[2].id, 'k1');
assert.equal(toasts[2].message, 'replacement');
assert.equal(toasts[2].kind, 'error');
// Dismiss by id (keys are ids).
toasts = toastList.dismissToast(toasts, 'k1');
assert.equal(toasts.length, 2);
toasts = toastList.dismissToast(toasts, 'missing');
assert.equal(toasts.length, 2);
// Cap: past MAX_TOASTS the oldest non-sticky toast is evicted.
let cappedToasts = [];
for (let i = 0; i < toastList.MAX_TOASTS + 2; i++) {
  cappedToasts = toastList.addToast(cappedToasts, { message: `m${i}` }, `id-${i}`);
}
assert.equal(cappedToasts.length, toastList.MAX_TOASTS);
assert.equal(cappedToasts[0].message, 'm2');
// Sticky toasts survive eviction while any non-sticky toast exists.
let stickyList = toastList.addToast([], { message: 'sticky', sticky: true }, 's');
for (let i = 0; i < toastList.MAX_TOASTS + 1; i++) {
  stickyList = toastList.addToast(stickyList, { message: `n${i}` }, `n-${i}`);
}
assert.equal(stickyList.length, toastList.MAX_TOASTS);
assert.ok(stickyList.some((t) => t.id === 's'), 'sticky toast survives the cap');

// Per-language discovery (Hebrew gap fix, 2026-11-15).
// discoverMinVoteCount: English keeps 10; other languages use 3.
assert.equal(util.discoverMinVoteCount('en'), 10);
assert.equal(util.discoverMinVoteCount('he'), 3);
assert.equal(util.discoverMinVoteCount('es'), 3);
assert.equal(util.discoverMinVoteCount('ko'), 3);

// primaryDiscoverPlans: one single-language call per language, 2 pages
// for <= 2 languages, 1 page beyond that; empty = old combined calls.
assert.deepEqual(util.primaryDiscoverPlans(['he', 'en']), [
  { languages: ['he'], page: 1, minVoteCount: 3 },
  { languages: ['he'], page: 2, minVoteCount: 3 },
  { languages: ['en'], page: 1, minVoteCount: 10 },
  { languages: ['en'], page: 2, minVoteCount: 10 },
]);
// Single-language (en-only) behavior is identical to today: same two
// pages, same threshold — only the language param shape changes from
// the combined list to the one language the profile has.
assert.deepEqual(util.primaryDiscoverPlans(['en']), [
  { languages: ['en'], page: 1, minVoteCount: 10 },
  { languages: ['en'], page: 2, minVoteCount: 10 },
]);
assert.deepEqual(util.primaryDiscoverPlans(['he', 'en', 'es']), [
  { languages: ['he'], page: 1, minVoteCount: 3 },
  { languages: ['en'], page: 1, minVoteCount: 10 },
  { languages: ['es'], page: 1, minVoteCount: 3 },
]);
assert.deepEqual(util.primaryDiscoverPlans([]), [
  { languages: [], page: 1, minVoteCount: 10 },
  { languages: [], page: 2, minVoteCount: 10 },
]);
// Duplicate languages collapse to one plan set each.
assert.equal(util.primaryDiscoverPlans(['he', 'he', 'en']).length, 4);

// genreDiscoverPlans: page 1 per language; none without genres.
assert.deepEqual(util.genreDiscoverPlans(['he', 'en'], [35, 18]), [
  { languages: ['he'], page: 1, minVoteCount: 3, genreIds: [35, 18] },
  { languages: ['en'], page: 1, minVoteCount: 10, genreIds: [35, 18] },
]);
assert.deepEqual(util.genreDiscoverPlans(['en'], [35]), [
  { languages: ['en'], page: 1, minVoteCount: 10, genreIds: [35] },
]);
assert.deepEqual(util.genreDiscoverPlans(['he', 'en'], []), []);
assert.deepEqual(util.genreDiscoverPlans([], [35]), [
  { languages: [], page: 1, minVoteCount: 10, genreIds: [35] },
]);

// languagePoolMinimum: up to 8 each, shrinking with more languages.
assert.equal(util.languagePoolMinimum(30, 2), 8);
assert.equal(util.languagePoolMinimum(30, 3), 8);
assert.equal(util.languagePoolMinimum(30, 4), 7);
assert.equal(util.languagePoolMinimum(30, 5), 6);
assert.equal(util.languagePoolMinimum(30, 6), 5);
assert.equal(util.languagePoolMinimum(30, 1), 0);
assert.equal(util.languagePoolMinimum(30, 0), 0);
assert.equal(util.languagePoolMinimum(0, 2), 0);

// ensureLanguageMinimums.
{
  const item = (id, lang) => ({ id, lang });
  const langOf = (c) => c.lang;
  // Deficit language swaps in from spares, replacing the lowest-ranked
  // surplus candidates; score order preserved.
  const ordered = [
    ...Array.from({ length: 24 }, (_, i) => item(`en${i}`, 'en')),
    ...Array.from({ length: 10 }, (_, i) => item(`he${i}`, 'he')),
  ];
  const picked = ordered.slice(0, 30); // 24 en + 6 he: he below the 8 floor
  const out = util.ensureLanguageMinimums(ordered, picked, langOf, ['he', 'en'], 8);
  assert.equal(out.length, 30);
  assert.equal(out.filter((c) => c.lang === 'he').length, 8);
  assert.equal(out.filter((c) => c.lang === 'en').length, 22);
  assert.ok(out.some((c) => c.id === 'he6') && out.some((c) => c.id === 'he7'), 'highest-ranked spares swap in');
  assert.ok(!out.some((c) => c.id === 'en23') && !out.some((c) => c.id === 'en22'), 'lowest-ranked surplus out');
  assert.deepEqual(out, ordered.filter((c) => out.includes(c)), 'score order preserved');
  // No-op when minimums are already met.
  const satisfied = util.ensureLanguageMinimums(ordered, ordered.slice(0, 30).concat(), langOf, ['he', 'en'], 6);
  assert.deepEqual(satisfied, ordered.slice(0, 30));
  // No-op for a single language / unrestricted profile.
  assert.strictEqual(util.ensureLanguageMinimums(ordered, picked, langOf, ['en'], 8), picked);
  assert.strictEqual(util.ensureLanguageMinimums(ordered, picked, langOf, [], 8), picked);
  // Availability cap: fewer spares than the deficit — all available
  // swap in, no invention, pool size unchanged.
  const scarce = [
    ...Array.from({ length: 28 }, (_, i) => item(`en${i}`, 'en')),
    ...Array.from({ length: 5 }, (_, i) => item(`he${i}`, 'he')),
  ];
  const scarcePicked = scarce.slice(0, 30); // 28 en + 2 he
  const scarceOut = util.ensureLanguageMinimums(scarce, scarcePicked, langOf, ['he', 'en'], 8);
  assert.equal(scarceOut.length, 30);
  assert.equal(scarceOut.filter((c) => c.lang === 'he').length, 5, 'all available Hebrew shows kept');
  // Unmeetable minimums: no language above the floor, so no victim
  // exists — the pool is left untouched rather than dropping one
  // language below the floor to satisfy another.
  const tight = [
    ...Array.from({ length: 7 }, (_, i) => item(`a${i}`, 'he')),
    ...Array.from({ length: 7 }, (_, i) => item(`b${i}`, 'en')),
    ...Array.from({ length: 8 }, (_, i) => item(`c${i}`, 'es')),
    ...Array.from({ length: 8 }, (_, i) => item(`d${i}`, 'ko')),
    item('spare-he', 'he'),
    item('spare-en', 'en'),
  ];
  const tightPicked = tight.slice(0, 30);
  assert.deepEqual(
    util.ensureLanguageMinimums(tight, tightPicked, langOf, ['he', 'en', 'es', 'ko'], 8),
    tightPicked,
  );
  // Empty pool stays empty; zero minimum is a no-op.
  assert.deepEqual(util.ensureLanguageMinimums(ordered, [], langOf, ['he', 'en'], 8), []);
  assert.strictEqual(util.ensureLanguageMinimums(ordered, picked, langOf, ['he', 'en'], 0), picked);
}

// effectiveRules — dimension-level override: a mood rule on a
// dimension suppresses every fixed rule on that dimension, and the
// fixed list is never mutated.
{
  const fixed = [
    { dimension: 'genre', operator: 'isNot', value: 10764, mode: 'hard' },
    { dimension: 'genre', operator: 'isNot', value: 10763, mode: 'soft' },
    { dimension: 'seasons', operator: 'gte', value: 3, mode: 'soft' },
  ];
  const overlay = [{ dimension: 'genre', operator: 'is', value: 18, mode: 'hard' }];
  assert.deepEqual(util.effectiveRules(fixed, overlay), [
    { dimension: 'seasons', operator: 'gte', value: 3, mode: 'soft' },
    { dimension: 'genre', operator: 'is', value: 18, mode: 'hard' },
  ]);
  assert.equal(fixed.length, 3, 'fixed rules untouched');
  assert.deepEqual(util.effectiveRules(fixed, []), fixed);
  assert.deepEqual(util.effectiveRules([], overlay), overlay);
  assert.deepEqual(util.effectiveRules([], []), []);
  // A mood rule on a dimension the fixed list does not use just appends.
  assert.deepEqual(
    util.effectiveRules([{ dimension: 'year', operator: 'gte', value: 2000, mode: 'soft' }], overlay),
    [
      { dimension: 'year', operator: 'gte', value: 2000, mode: 'soft' },
      { dimension: 'genre', operator: 'is', value: 18, mode: 'hard' },
    ],
  );
}

// parseMoodRulesJson — bad JSON / bad rules read as no rules, never throw.
assert.deepEqual(util.parseMoodRulesJson(null), []);
assert.deepEqual(util.parseMoodRulesJson(''), []);
assert.deepEqual(util.parseMoodRulesJson('not json'), []);
assert.deepEqual(util.parseMoodRulesJson('[{"dimension":"genre","operator":"is","value":999,"mode":"hard"}]'), []);
assert.deepEqual(
  util.parseMoodRulesJson('[{"dimension":"country","operator":"is","value":"il","mode":"hard"}]'),
  [{ dimension: 'country', operator: 'is', value: 'IL', mode: 'hard' }],
);

// PRESET_MOODS — every preset's rules must survive validation
// unchanged (the migration embeds the same rules as SQL literals).
{
  assert.equal(util.PRESET_MOODS.length, 4);
  const keys = new Set();
  for (const preset of util.PRESET_MOODS) {
    assert.ok(preset.key && !keys.has(preset.key), 'unique preset key');
    keys.add(preset.key);
    assert.ok(preset.textEn && preset.textHe, 'bilingual preset text');
    assert.deepEqual(util.validateRules(preset.rules), preset.rules, `preset ${preset.key} rules valid`);
  }
}

await writeFile(join(root, 'node_modules', '.selftest-ok'), 'ok');
console.log('selftest: all assertions passed');
