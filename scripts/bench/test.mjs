// Unit tests for the bench suite: token/neuron accounting, scoring,
// case/model definitions, and classification parity with the shipped
// worker code. No network, no AI calls.
// Run: node scripts/bench/test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTPUT_TOKEN_ASSUMPTIONS,
  SAFETY_FACTOR,
  estimateTokens,
  loadWorkerModules,
  measureSuite,
  neuronsForCall,
  scoreConsolidation,
  scoreRanking,
  summarizeModelRuns,
} from './lib.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(await readFile(join(dir, 'cases.json'), 'utf-8'));
const modelsDoc = JSON.parse(await readFile(join(dir, 'models.json'), 'utf-8'));
const models = modelsDoc.models;

// ---------------------------------------------------------------- tokens

assert.equal(estimateTokens(''), 0);
assert.equal(estimateTokens('abcd'), 1);
assert.equal(estimateTokens('a'.repeat(400)), 100);
assert.equal(estimateTokens('א'.repeat(25)), 10); // Hebrew: 2.5 chars/token
assert.equal(estimateTokens('a'.repeat(400) + 'א'.repeat(25)), 110);
assert.ok(estimateTokens('hello world, this is a test') > 0);
// Deterministic.
assert.equal(estimateTokens('אוהב סדרות קומיות קצרות'), estimateTokens('אוהב סדרות קומיות קצרות'));

// ---------------------------------------------------------------- neurons

const m70 = models[0];
assert.equal(neuronsForCall(m70, 1e6, 1e6), 26668 + 204805);
assert.equal(neuronsForCall(models[1], 1e6, 0), 4119);
assert.equal(neuronsForCall(models[2], 0, 1e6), 27273);
assert.equal(SAFETY_FACTOR, 1.15);
assert.deepEqual(Object.keys(OUTPUT_TOKEN_ASSUMPTIONS).sort(), ['consolidation', 'rank', 'removal']);

// ---------------------------------------------------------------- models

assert.equal(models.length, 4, 'exactly four candidate models');
assert.equal(models.filter((m) => m.reference).length, 1, 'exactly one reference');
assert.equal(models.find((m) => m.reference).id, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
assert.ok(!models.some((m) => m.id.includes('qwen3-30b-a3b')), 'deprecated Qwen MoE must stay out');
assert.ok(models.every((m) => m.neuronsInPerM > 0 && m.neuronsOutPerM > 0 && m.marker));
assert.ok(models.some((m) => m.id === '@cf/meta/llama-3.1-8b-instruct-fp8-fast'), 'fp8-fast 8B, not plain fp8');
assert.ok(!models.some((m) => m.id === '@cf/meta/llama-3.1-8b-instruct-fp8'), 'plain -fp8 variant is deprecated Nov 20');

// ---------------------------------------------------------------- cases

const consIds = cases.consolidation.map((c) => c.id);
const rankIds = cases.ranking.map((c) => c.id);
assert.equal(new Set([...consIds, ...rankIds]).size, consIds.length + rankIds.length, 'case ids unique');
assert.ok(cases.consolidation.length >= 4, 'consolidation coverage');
assert.ok(cases.ranking.length >= 1, 'ranking coverage');
for (const c of cases.consolidation) {
  assert.ok(['he', 'en'].includes(c.uiLang), `${c.id}: uiLang`);
  assert.ok(c.languages.length > 0, `${c.id}: languages`);
  assert.ok(c.seed.notes.length >= 1, `${c.id}: at least one note`);
  assert.ok(['shared', 'casual', 'deep'].includes(c.expect.section), `${c.id}: section`);
  assert.ok(
    (c.expect.mustContainAny?.length ?? 0) + (c.expect.mustContainAll?.length ?? 0) > 0,
    `${c.id}: needs a content expectation`,
  );
  // No case may embed Eyal's real combined dev note verbatim.
  for (const note of c.seed.notes) {
    assert.ok(!note.includes('מעדיף תוכניות שהסתיימו'), `${c.id}: synthetic notes only`);
  }
}
for (const c of cases.ranking) {
  // Bootstrap-complete by the same rule as db.ts: 5+ rated, 1+ negative, 1+ note.
  const latest = new Map();
  for (const r of c.seed.ratings) latest.set(r.tmdbId, r.rating);
  const negatives = [...latest.values()].filter((r) => r !== 'liked').length;
  assert.ok(latest.size >= 5, `${c.id}: 5+ rated`);
  assert.ok(negatives >= 1, `${c.id}: 1+ negative`);
  assert.ok(c.seed.notes.length >= 1, `${c.id}: 1+ note`);
  assert.ok(c.seed.tasteSections?.shared?.trim(), `${c.id}: seeded shared section`);
  assert.ok(c.seed.ratings.every((r) => Number.isInteger(r.tmdbId) && r.showTitle), `${c.id}: ratings need ids+titles`);
}

// ---------------------------------------------------------------- worker parity

const { util, llm } = await loadWorkerModules();
// classifyKind via the same bundle the scorer uses (Hazbin matrix).
assert.equal(util.classifyKind([16, 35, 18, 10765]), 'casual');
assert.equal(util.classifyKind([18, 80]), 'deep');
assert.equal(util.classifyKind([35]), 'casual');
assert.equal(util.clusterFor([16, 35]), 'animation');
assert.equal(util.clusterFor([18]), 'drama');
// Prompt builders are the real ones.
const req = llm.buildRankPrompt('taste', 'deep', [{ tmdbId: 1, title: 'X', year: '2020', genres: ['Drama'], originalLanguage: 'en', originCountry: ['US'] }], 'he');
assert.ok(req.system.includes('KIND FIT'), 'rank prompt carries the kind-fit rule');
const cons = llm.buildConsolidationPrompt([{ kind: 'note', source: 'note', text: 'x', createdAt: 1 }], 'he', null, ['he']);
assert.ok(cons.system.includes('THREE sections'), 'consolidation prompt carries the split contract');

// ---------------------------------------------------------------- measurement

const est1 = await measureSuite(cases, modelsDoc);
const est2 = await measureSuite(cases, modelsDoc);
assert.deepEqual(est1, est2, 'measurement is deterministic');
assert.equal(est1.steps.length, cases.consolidation.length + cases.ranking.length);
assert.ok(est1.modeled.rankInputTokens > 500, 'modeled rank prompt is substantial');
assert.ok(est1.modeled.rankInputTokens > est1.modeled.removalInputTokens);
for (const m of models) {
  assert.ok(est1.perModel[m.id].total > 0, `${m.short}: positive cost`);
  assert.ok(
    est1.perModel[m.id].total < est1.perModel[models[0].id].total || m.reference,
    'candidates cost less than the 70B reference',
  );
}
assert.ok(est1.total > 0);
assert.ok(est1.total <= 2000, `suite must fit the 2,000-neuron cap, got ${est1.total.toFixed(0)}`);
console.log(`estimate: total ${est1.total.toFixed(0)} neurons (cap 2000, margin ${(2000 - est1.total).toFixed(0)})`);
for (const m of models) {
  console.log(`  ${m.short}: ${est1.perModel[m.id].total.toFixed(0)}`);
}

// ---------------------------------------------------------------- scoring

const consCase = cases.consolidation[0];
const good = scoreConsolidation(
  consCase,
  {
    sections: { shared: '', casual: 'אוהב משהו קליל ברקע בערב.', deep: '' },
    contradictions: [],
    provider: 'workers-ai:llama-3.3-70b',
  },
  'llama-3.3-70b',
);
assert.equal(good.checks.routed, true);
assert.equal(good.checks.notElsewhere, true);
assert.equal(good.checks.provider, true);
assert.equal(good.score, 1);
const bad = scoreConsolidation(
  consCase,
  {
    sections: { shared: 'אוהב משהו קליל ברקע.', casual: '', deep: '' },
    contradictions: [],
    provider: 'workers-ai:llama-3.3-70b',
  },
  'llama-3.3-70b',
);
assert.equal(bad.checks.routed, false);
assert.equal(bad.checks.notElsewhere, false);
assert.ok(bad.score < 1);

const negCase = cases.consolidation.find((c) => c.id === 'cons-en-dislike');
const neg = scoreConsolidation(
  negCase,
  {
    sections: { shared: 'Breaking Bad is liked. Never suggest reality TV.', casual: '', deep: '' },
    contradictions: [],
    provider: 'mock',
  },
  'llama-3.3-70b',
);
assert.equal(neg.checks.routed, true);
assert.equal(neg.checks.sentiment, true);
assert.equal(neg.checks.ratingsShared, true);
assert.equal(neg.checks.provider, false, 'mock provider fails the marker check');

const contraCase = cases.consolidation.find((c) => c.id === 'cons-he-contradiction');
const contra = scoreConsolidation(
  contraCase,
  {
    sections: { shared: 'דברים רציניים ומותחים.', casual: '', deep: '' },
    contradictions: [{ scope: 'shared', oldText: 'a', newText: 'b', proposedMerge: 'c' }],
    provider: 'mock',
  },
  null,
);
assert.equal(contra.checks.contradictionFound, true);

const rankCase = cases.ranking[0];
const details = {
  1396: [18, 80], // Breaking Bad -> deep
  2316: [35], // The Office -> casual
  2190: [16, 35], // South Park -> casual (Hazbin rule)
  456: [16, 35], // Simpsons -> casual
};
const rankScore = await scoreRanking(
  rankCase,
  {
    casual: [{ tmdbId: 2316, rationale: 'r' }, { tmdbId: 1396, rationale: 'r' }],
    deep: [{ tmdbId: 1396, rationale: 'r' }],
    stale: false,
  },
  details,
  { casual: [2316], deep: [1396] },
);
assert.equal(rankScore.perList.casual.kindFit, 0.5, 'Breaking Bad in casual is a kind misfit');
assert.equal(rankScore.perList.deep.kindFit, 1);
assert.equal(rankScore.overlap.casual, 0.5);
assert.equal(rankScore.overlap.deep, 1);
assert.equal(rankScore.perList.casual.clusterCapOk, true);

const summary = summarizeModelRuns([good, neg], [rankScore]);
assert.ok(summary.routingAccuracy >= 0 && summary.routingAccuracy <= 1);
assert.equal(summary.cases, 3);

console.log('bench tests: all assertions passed');
