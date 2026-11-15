// Bench shared library: token/neuron estimation, prompt measurement via
// the REAL prompt builders, and deterministic scoring. No network, no
// Workers AI calls — everything here is pure computation over fixtures
// and recorded API responses.
//
// Run through the CLIs (measure.mjs / score.mjs) or the unit tests
// (test.mjs). The worker modules are bundled with esbuild on first use
// (same pattern as scripts/selftest.mjs) so classification and prompt
// construction can never drift from the shipped code.
import { build } from 'esbuild';
import { unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cached = null;

/** Bundle worker/src/llm.ts + worker/src/util.ts and return their exports. */
export async function loadWorkerModules() {
  if (cached) return cached;
  const llmOut = join(root, 'node_modules', '.bench-llm.mjs');
  const utilOut = join(root, 'node_modules', '.bench-util.mjs');
  await build({
    entryPoints: [join(root, 'worker', 'src', 'llm.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: llmOut,
    logLevel: 'silent',
  });
  await build({
    entryPoints: [join(root, 'worker', 'src', 'util.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: utilOut,
    logLevel: 'silent',
  });
  const [llm, util] = await Promise.all([import(llmOut), import(utilOut)]);
  await unlink(llmOut).catch(() => {});
  await unlink(utilOut).catch(() => {});
  cached = { llm, util };
  return cached;
}

// ---------------------------------------------------------------- tokens

const HEBREW_RE = /[\u0590-\u05FF]/g;

/**
 * Conservative token estimate for mixed English/Hebrew text.
 * English BPE averages ~4 chars/token; Hebrew ~2.5 chars/token on
 * Llama-family tokenizers. Counting each script at its own rate keeps
 * the estimate conservative for Hebrew-heavy prompts (the app's main
 * case) without wildly over-counting English ones. This is a budgeting
 * heuristic, not a tokenizer — the SAFETY_FACTOR below absorbs the
 * remaining error. Deterministic: same text, same number, always.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const chars = [...text];
  const hebrew = (text.match(HEBREW_RE) || []).length;
  const other = chars.length - hebrew;
  return Math.ceil(other / 4 + hebrew / 2.5);
}

/** Applied on top of every per-call neuron estimate. */
export const SAFETY_FACTOR = 1.15;

/**
 * Assumed output sizes (tokens) per call type. The maxTokens caps are
 * 1000 (consolidation) / 1200 (rank) / 300 (removal); real outputs run
 * well under the caps, but the assumptions stay generous so the budget
 * errs toward overestimation. Documented here, asserted in test.mjs.
 */
export const OUTPUT_TOKEN_ASSUMPTIONS = {
  consolidation: 300,
  rank: 400,
  removal: 30,
};

/** Neurons for one call at a model's published rates. */
export function neuronsForCall(model, inTokens, outTokens) {
  return (inTokens / 1e6) * model.neuronsInPerM + (outTokens / 1e6) * model.neuronsOutPerM;
}

// ---------------------------------------------------------------- measurement

/**
 * A realistic 30-candidate rank pool for cost modeling: Hebrew genre
 * labels (longer than English ones), mixed Hebrew/English titles,
 * anchors on every line. The pool cap is 30, so modeling a full pool is
 * the conservative case — real pools are usually smaller.
 */
function modeledCandidates(count) {
  const genres = [
    ['דרמה', 'פשע'],
    ['קומדיה'],
    ['אנימציה', 'קומדיה', 'דרמה', 'מדע בדיוני ופנטזיה'],
    ['דרמה', 'מסתורין'],
    ['מדע בדיוני ופנטזיה', 'דרמה'],
    ['תיעודי'],
    ['קומדיה', 'משפחה'],
    ['דרמה', 'מלחמה ופוליטיקה'],
  ];
  const titles = [
    'סדרה ישראלית עם שם ארוך לצורך מדידה',
    'A Long English Show Title For Measurement',
    'פאודה',
    'The Long Night of the Barren Lands',
    'סמוך על סול',
  ];
  return Array.from({ length: count }, (_, i) => ({
    tmdbId: 900000 + i,
    title: titles[i % titles.length],
    year: '2021',
    genres: genres[i % genres.length],
    originalLanguage: i % 3 === 0 ? 'he' : 'en',
    originCountry: i % 3 === 0 ? ['IL'] : ['US'],
    anchorTitle: 'שובר שורות',
  }));
}

const MODELED_TASTE =
  'אוהב דרמות מתח, פשע וקומדיות. לא אוהב ריאלטי ותוכניות אירוח.\n' +
  'קומדיות קצרות וקלילות לערב.\n' +
  'דרמות מתח מורכבות שדורשות ריכוז.\n\n' +
  'Recent signals (newest first — what the profile rated or noted lately; weigh these alongside, not instead of, the taste description above):\n' +
  '[note] אוהב דרמות מתח וקומדיות קצרות. לא אוהב ריאלטי.';

/**
 * Measure the exact input size of every call the suite will make, using
 * the real prompt builders. Consolidation prompts are built from the
 * case's own seed (byte-identical to what the server builds for the
 * seeded log); rank/removal prompts use the modeled full pool above.
 * Returns the per-step cost table the runner enforces the cap with.
 */
export async function measureSuite(cases, modelsDoc) {
  const { llm } = await loadWorkerModules();
  const models = modelsDoc.models;
  const embeddingAllowance = modelsDoc.embedding?.allowancePerGeneration ?? 5;
  const steps = [];
  const modeledRank = llm.buildRankPrompt(MODELED_TASTE, 'deep', modeledCandidates(30), 'he');
  const modeledRemoval = llm.buildRemovalCheckPrompt(
    [
      { title: 'The Simpsons', year: '1989', genres: ['אנימציה', 'קומדיה'] },
      { title: 'Reality Show', year: '2020', genres: ['ריאלטי'] },
      { title: 'Talk Show', year: '2019', genres: ['תוכנית אירוח'] },
    ],
    modeledCandidates(15),
    'he',
  );
  const rankIn = estimateTokens(modeledRank.system + modeledRank.user);
  const removalIn = estimateTokens(modeledRemoval.system + modeledRemoval.user);

  for (const c of cases.consolidation) {
    const notes = [];
    for (const r of c.seed.ratings) {
      notes.push({
        kind: r.rating,
        source: 'rating',
        text: r.text?.trim() ? `${r.showTitle}: ${r.text}` : r.showTitle,
        createdAt: notes.length + 1,
      });
    }
    for (const text of c.seed.notes) {
      notes.push({ kind: 'note', source: 'note', text, createdAt: notes.length + 1 });
    }
    const req = llm.buildConsolidationPrompt(
      notes,
      c.uiLang,
      c.seed.existingSummary ?? null,
      c.languages,
    );
    const inTokens = estimateTokens(req.system + req.user);
    steps.push({
      caseId: c.id,
      kind: 'consolidation',
      calls: [{ type: 'consolidation', inTokens, outTokens: OUTPUT_TOKEN_ASSUMPTIONS.consolidation }],
    });
  }
  for (const c of cases.ranking) {
    steps.push({
      caseId: c.id,
      kind: 'ranking',
      calls: [
        { type: 'rank', inTokens: rankIn, outTokens: OUTPUT_TOKEN_ASSUMPTIONS.rank },
        { type: 'rank', inTokens: rankIn, outTokens: OUTPUT_TOKEN_ASSUMPTIONS.rank },
        { type: 'rank', inTokens: rankIn, outTokens: OUTPUT_TOKEN_ASSUMPTIONS.rank },
        { type: 'rank', inTokens: rankIn, outTokens: OUTPUT_TOKEN_ASSUMPTIONS.rank },
        { type: 'removal', inTokens: removalIn, outTokens: OUTPUT_TOKEN_ASSUMPTIONS.removal },
        { type: 'removal', inTokens: removalIn, outTokens: OUTPUT_TOKEN_ASSUMPTIONS.removal },
      ],
    });
  }

  const perModel = {};
  for (const m of models) {
    let total = 0;
    const byCase = {};
    for (const step of steps) {
      let cost = step.calls.reduce(
        (acc, call) => acc + neuronsForCall(m, call.inTokens, call.outTokens),
        0,
      );
      if (step.kind === 'ranking') cost += embeddingAllowance;
      cost *= SAFETY_FACTOR;
      byCase[step.caseId] = cost;
      total += cost;
    }
    perModel[m.id] = { total, byCase };
  }
  const total = Object.values(perModel).reduce((acc, m) => acc + m.total, 0);
  return {
    steps,
    modeled: {
      rankInputTokens: rankIn,
      removalInputTokens: removalIn,
      rankInputChars: [...(modeledRank.system + modeledRank.user)].length,
      removalInputChars: [...(modeledRemoval.system + modeledRemoval.user)].length,
    },
    perModel,
    total,
  };
}

// ---------------------------------------------------------------- scoring

function containsAny(haystack, needles) {
  const lower = (haystack ?? '').toLowerCase();
  return (needles ?? []).some((n) => lower.includes(n.toLowerCase()));
}

function containsAll(haystack, needles) {
  const lower = (haystack ?? '').toLowerCase();
  return (needles ?? []).every((n) => lower.includes(n.toLowerCase()));
}

/**
 * Score one consolidation run. Checks are recorded individually — the
 * headline score is the fraction of applicable checks passed, and the
 * raw sections are always kept for human review (keyword scoring of
 * free-form Hebrew summaries is approximate by nature).
 */
export function scoreConsolidation(caseDef, response, expectedMarker) {
  const sections = response?.sections ?? { shared: '', casual: '', deep: '' };
  const expect = caseDef.expect;
  const target = sections[expect.section] ?? '';
  const others = ['shared', 'casual', 'deep']
    .filter((k) => k !== expect.section)
    .map((k) => sections[k] ?? '')
    .join('\n');
  const checks = {};
  if (expect.mustContainAny) {
    checks.routed = containsAny(target, expect.mustContainAny);
  }
  if (expect.mustContainAll) {
    checks.nuance = containsAll(target, expect.mustContainAll);
  }
  if (expect.absentAnywhereElse) {
    checks.notElsewhere = !containsAny(others, expect.absentAnywhereElse);
  }
  if (expect.negationAnyOf) {
    checks.sentiment = containsAny(target, expect.negationAnyOf);
  }
  if (expect.ratingTitlesInShared) {
    checks.ratingsShared = containsAll(sections.shared ?? '', expect.ratingTitlesInShared);
  }
  const contradictions = response?.contradictions ?? [];
  if (expect.contradictionsMin) {
    checks.contradictionFound =
      contradictions.length >= expect.contradictionsMin &&
      (!expect.contradictionScope ||
        contradictions.some((c) => c.scope === expect.contradictionScope));
  }
  if (expectedMarker) {
    checks.provider = String(response?.provider ?? '').includes(expectedMarker);
  }
  const values = Object.values(checks);
  return {
    caseId: caseDef.id,
    checks,
    score: values.length ? values.filter(Boolean).length / values.length : 0,
    sections,
    contradictions,
  };
}

/**
 * Score one ranking run from the lists response plus a tmdbId ->
 * genreIds map (fetched by the runner via /api/shows/:id). Kind-fit is
 * the end-to-end outcome: the heuristic kind of each surfaced show
 * against the list it landed in. `referenceIds` (the reference model's
 * id sets for this case) enables overlap scoring; null skips it.
 */
export async function scoreRanking(caseDef, lists, detailsById, referenceIds) {
  const { util } = await loadWorkerModules();
  const perList = {};
  for (const kind of ['casual', 'deep']) {
    const items = lists?.[kind] ?? [];
    let kindFit = 0;
    let classified = 0;
    let withRationale = 0;
    const clusters = new Map();
    const unresolved = [];
    for (const item of items) {
      const genreIds = detailsById[item.tmdbId];
      if (!genreIds) {
        unresolved.push(item.tmdbId);
        continue;
      }
      classified++;
      if (util.classifyKind(genreIds) === kind) kindFit++;
      const cluster = util.clusterFor(genreIds);
      clusters.set(cluster, (clusters.get(cluster) ?? 0) + 1);
      if (item.rationale?.trim()) withRationale++;
    }
    const maxCluster = Math.max(0, ...clusters.values());
    perList[kind] = {
      length: items.length,
      classified,
      kindFit: classified ? kindFit / classified : 0,
      kindFitCount: `${kindFit}/${classified}`,
      clusterCapOk: maxCluster <= 3,
      maxCluster,
      unresolved,
      rationalePresent: items.length ? withRationale / items.length : 0,
      shortReason: lists?.[`${kind}ShortReason`] ?? lists?.shortReason ?? null,
      stale: Boolean(lists?.stale),
    };
  }
  let overlap = null;
  if (referenceIds) {
    overlap = {};
    for (const kind of ['casual', 'deep']) {
      const mine = new Set((lists?.[kind] ?? []).map((i) => i.tmdbId));
      const ref = new Set(referenceIds[kind] ?? []);
      const inter = [...mine].filter((id) => ref.has(id)).length;
      const union = new Set([...mine, ...ref]).size;
      overlap[kind] = union ? inter / union : 0;
    }
  }
  return { caseId: caseDef.id, perList, overlap };
}

/** Aggregate per-model summary from scored runs. */
export function summarizeModelRuns(consScores, rankScores) {
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const routed = consScores.map((s) => (s.checks.routed === undefined ? null : s.checks.routed ? 1 : 0)).filter((v) => v !== null);
  const sentiment = consScores.map((s) => (s.checks.sentiment === undefined ? null : s.checks.sentiment ? 1 : 0)).filter((v) => v !== null);
  const contradiction = consScores.map((s) => (s.checks.contradictionFound === undefined ? null : s.checks.contradictionFound ? 1 : 0)).filter((v) => v !== null);
  const kindFit = rankScores.flatMap((s) => [s.perList.casual.kindFit, s.perList.deep.kindFit]);
  const clusterOk = rankScores.flatMap((s) => [s.perList.casual.clusterCapOk, s.perList.deep.clusterCapOk]);
  const overlaps = rankScores.flatMap((s) => (s.overlap ? [s.overlap.casual, s.overlap.deep] : []));
  return {
    consolidationMean: mean(consScores.map((s) => s.score)),
    routingAccuracy: mean(routed),
    sentimentAccuracy: mean(sentiment),
    contradictionDetection: mean(contradiction),
    rankingKindFit: mean(kindFit),
    clusterCapCompliance: mean(clusterOk.map((v) => (v ? 1 : 0))),
    overlapVsReference: overlaps.length ? mean(overlaps) : null,
    cases: consScores.length + rankScores.length,
  };
}
