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

// Rail scroll direction helpers (src/railScroll.ts): pure, tested for
// both LTR and RTL — no real browser is available in this environment.
const railOutFile = join(root, 'node_modules', '.selftest-rail.mjs');
await build({
  entryPoints: [join(root, 'src', 'railScroll.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: railOutFile,
  logLevel: 'silent',
});
const rail = await import(railOutFile);
await unlink(railOutFile).catch(() => {});

// railScrollDelta: forward reveals the next cards in both directions.
assert.equal(rail.railScrollDelta('ltr', true, 800), 800);
assert.equal(rail.railScrollDelta('ltr', false, 800), -800);
assert.equal(rail.railScrollDelta('rtl', true, 800), -800);
assert.equal(rail.railScrollDelta('rtl', false, 800), 800);
assert.ok(rail.railScrollDelta('ltr', true, 0) === 0);
assert.ok(rail.railScrollDelta('rtl', true, 0) === 0);
// railArrowGlyphs: the forward arrow points LEFT in RTL, RIGHT in LTR.
assert.deepEqual(rail.railArrowGlyphs('en'), { forward: '›', back: '‹' });
assert.deepEqual(rail.railArrowGlyphs('he'), { forward: '‹', back: '›' });

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
assert.deepEqual(
  util.orderCapped(capItems, (x) => util.clusterFor(x.g), 3).map((x) => x.id),
  [1, 2, 3, 5, 6, 7, 8, 4],
);
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

await writeFile(join(root, 'node_modules', '.selftest-ok'), 'ok');
console.log('selftest: all assertions passed');
