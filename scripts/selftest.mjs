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
// No cap pressure: all items ordered, capBound false
const free = rerank.deterministicRerank(capItems2.slice(0, 3), 'casual', new Map(), 3);
assert.equal(free.ordered.length, 3);
assert.equal(free.capBound, false);
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
assert.ok(consolParsed.sections.shared.includes('Fauda')); // ratings -> Shared
assert.ok(consolParsed.sections.shared.includes('The Office'));
assert.ok(consolParsed.sections.shared.includes('No horror')); // ambiguous -> Shared
assert.ok(consolParsed.sections.casual.includes('light')); // casual cue routes
assert.ok(consolParsed.sections.deep.includes('immersive')); // deep cue routes
assert.deepEqual(consolParsed.contradictions, []);
assert.equal(consolParsed.languageConflict, null);

const rankCands = [
  { tmdbId: 11, title: 'Alpha Show', year: '2020', genres: ['Comedy'], originalLanguage: 'en', originCountry: ['US'], anchorTitle: 'Seinfeld' },
  { tmdbId: 22, title: 'Beta Drama', year: '2021', genres: ['Drama'], originalLanguage: 'en', originCountry: ['US'] },
  { tmdbId: 33, title: 'Gamma Toon', year: '2019', genres: ['Animation', 'Comedy'], originalLanguage: 'en', originCountry: ['US'], anchorTitle: 'The Simpsons' },
];
const rankReq = llm.buildRankPrompt('Love comedies, no horror.', 'casual', rankCands, 'en');
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

const adhocReq = llm.buildAdhocRationalePrompt('something funny', rankCands[0], 'en');
const adhocOut = await mockProvider.generate(adhocReq);
assert.ok(adhocOut.includes('Alpha Show') && adhocOut.includes('2020'));
assert.equal(adhocOut, await mockProvider.generate(adhocReq));

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

// --- provider selection: default is real; mock needs the flag; override needs dev ---

assert.equal(llm.DEFAULT_CHAT_MODEL, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
assert.equal(llm.CHEAP_CHAT_MODEL, '@cf/meta/llama-3.1-8b-instruct-fp8');
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

// Defense in depth: the override header is IGNORED without IS_DEV_WORKER=true.
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi }, 'mock'), { kind: 'real', model: llm.DEFAULT_CHAT_MODEL });
assert.deepEqual(llm.resolveLlmMode({}, 'mock'), { kind: 'stub' });
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'false' }, 'mock'), { kind: 'real', model: llm.DEFAULT_CHAT_MODEL });
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: '1' }, 'mock'), { kind: 'real', model: llm.DEFAULT_CHAT_MODEL });
// On the dev Worker the override is honored.
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'true' }, 'mock'), { kind: 'mock' });
assert.deepEqual(
  llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'true' }, 'cheap'),
  { kind: 'real', model: llm.CHEAP_CHAT_MODEL },
);
assert.deepEqual(
  llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'true', LLM_MODEL: 'custom-cheap' }, 'cheap'),
  { kind: 'real', model: 'custom-cheap' },
);
// Cheap without an AI binding degrades to stub, never to a crash.
assert.deepEqual(llm.resolveLlmMode({ IS_DEV_WORKER: 'true' }, 'cheap'), { kind: 'stub' });
// Invalid override values are ignored (env default wins).
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'true' }, 'bogus'), { kind: 'real', model: llm.DEFAULT_CHAT_MODEL });
assert.deepEqual(llm.resolveLlmMode({ AI: fakeAi, IS_DEV_WORKER: 'true' }, null), { kind: 'real', model: llm.DEFAULT_CHAT_MODEL });
assert.equal(llm.isDevWorker({ IS_DEV_WORKER: 'true' }), true);
assert.equal(llm.isDevWorker({}), false);
assert.equal(llm.parseDevOverride('mock'), 'mock');
assert.equal(llm.parseDevOverride('cheap'), 'cheap');
assert.equal(llm.parseDevOverride('MOCK'), null);
assert.equal(llm.parseDevOverride(undefined), null);

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

await writeFile(join(root, 'node_modules', '.selftest-ok'), 'ok');
console.log('selftest: all assertions passed');
