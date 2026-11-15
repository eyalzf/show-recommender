// Score recorded bench runs. Input: a JSON doc
// { cases, models, runs: [{ modelId, caseId, kind, response, details }] }
// where `response` is the raw API response and `details` maps tmdbId ->
// genreIds for ranking runs. Prints { perModel, runs } JSON. No network.
// Usage: node scripts/bench/score.mjs <results.json>
import { readFile } from 'node:fs/promises';
import { scoreConsolidation, scoreRanking, summarizeModelRuns } from './lib.mjs';

const doc = JSON.parse(await readFile(process.argv[2], 'utf-8'));
const caseById = new Map(
  [...doc.cases.consolidation, ...doc.cases.ranking].map((c) => [c.id, c]),
);
const modelById = new Map(doc.models.models.map((m) => [m.id, m]));
const reference = doc.models.models.find((m) => m.reference);

// Reference id sets per ranking case (for overlap scoring).
const referenceIds = {};
for (const run of doc.runs) {
  if (run.modelId === reference.id && run.kind === 'ranking') {
    referenceIds[run.caseId] = {
      casual: (run.response?.casual ?? []).map((i) => i.tmdbId),
      deep: (run.response?.deep ?? []).map((i) => i.tmdbId),
    };
  }
}

const scored = [];
for (const run of doc.runs) {
  const caseDef = caseById.get(run.caseId);
  const model = modelById.get(run.modelId);
  if (!caseDef || !model) continue;
  if (run.kind === 'consolidation') {
    scored.push({
      modelId: run.modelId,
      kind: 'consolidation',
      ...scoreConsolidation(caseDef, run.response, model.marker),
    });
  } else {
    scored.push({
      modelId: run.modelId,
      kind: 'ranking',
      ...(await scoreRanking(caseDef, run.response, run.details ?? {}, referenceIds[run.caseId] ?? null)),
    });
  }
}

const perModel = {};
for (const m of doc.models.models) {
  const cons = scored.filter((s) => s.modelId === m.id && s.kind === 'consolidation');
  const rank = scored.filter((s) => s.modelId === m.id && s.kind === 'ranking');
  perModel[m.id] = summarizeModelRuns(cons, rank);
}
console.log(JSON.stringify({ perModel, runs: scored }, null, 2));
