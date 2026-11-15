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

// classifyKind
assert.equal(util.classifyKind(['Comedy']), 'casual');
assert.equal(util.classifyKind(['Drama', 'Crime']), 'deep');
assert.equal(util.classifyKind(['Comedy', 'Drama']), 'deep'); // tie -> Drama wins
assert.equal(util.classifyKind(['Reality']), 'casual');
assert.equal(util.classifyKind(['Documentary']), 'deep');
assert.equal(util.classifyKind([]), 'deep');

// classifyType
assert.equal(util.classifyType(['Reality'], 3, 30, 'Returning Series'), 'reality');
assert.equal(util.classifyType(['Documentary'], 1, 4, 'Ended'), 'docuseries');
assert.equal(util.classifyType(['Drama'], 1, 8, 'Ended'), 'limited');
assert.equal(util.classifyType(['Drama'], 1, 20, 'Ended'), 'series');
assert.equal(util.classifyType(['Drama'], 3, 30, 'Ended'), 'series');

// tone / pace / structure
assert.equal(util.toneFor(['Comedy']), 'Light');
assert.equal(util.toneFor(['Mystery']), 'Tense');
assert.equal(util.paceFor(25), 'Brisk');
assert.equal(util.paceFor(45), 'Steady');
assert.equal(util.paceFor(60), 'Unhurried');
assert.equal(util.paceFor(null), 'Steady');
assert.equal(util.structureFor(['Comedy']), 'episodic');
assert.equal(util.structureFor(['Drama']), 'serialized');

// displaySeasons: season 0 (specials) never counts
assert.equal(
  util.displaySeasons([{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }], 3),
  2,
);
assert.equal(util.displaySeasons(null, 4), 4);

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
assert.equal(con.contradictions.length, 1);
assert.equal(con.languageConflict.languageCode, 'ko');
const plain = util.parseConsolidationResponse('Just a plain summary.');
assert.equal(plain.summary, 'Just a plain summary.');
assert.equal(plain.contradictions.length, 0);

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
