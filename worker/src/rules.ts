/**
 * Rule extraction — the ONE service every path routes through.
 *
 * History: extraction grew as three copies (consolidation prompt,
 * mood prompt, mock simulator) sharing only the grounding backstop,
 * and the copies drifted — a Hebrew synonym fixed in one place stayed
 * broken in the others. Now:
 *  - the vocabulary (markers + cue tables) lives in util.ts;
 *  - the RULES prompt spec is one fragment (llm.rulesSpecFragment)
 *    embedded by both extraction prompts;
 *  - THIS module owns parsing, validation, and grounding for every
 *    extraction, and the end-to-end mood extraction.
 *
 * The two call shapes stay deliberately different: consolidation
 * bundles rules with the summary in a single model call (splitting
 * it would double invocations per consolidation), while a mood is a
 * standalone rules-only call. Both pass through resolveRules below,
 * so the parse/validate/ground behavior is identical.
 */
import { buildMoodExtractionPrompt, type LlmProvider } from './llm';
import { groundRules, validateRules, type PreferenceRule } from './util';

/**
 * Parse a rules-only model response. Tolerant: anything unparseable
 * reads as no rules; every rule is validated against the fixed lists.
 */
export function parseRulesJson(text: string): PreferenceRule[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { rules?: unknown };
    return validateRules(parsed.rules);
  } catch {
    return [];
  }
}

/**
 * Validate + ground candidate rules against the statements that
 * produced them. Drops rules no statement names (the model has
 * invented categories twice) and demotes hard rules whose backing
 * statements carry no categorical wording to soft. Grounding input
 * is the caller's statements only — rating lines never ground a
 * rule (per-show feedback is not a category statement).
 */
export function resolveRules(candidates: unknown, groundingTexts: string[]): PreferenceRule[] {
  return groundRules(validateRules(candidates), groundingTexts);
}

/**
 * End-to-end mood extraction: one statement in, grounded rules out.
 * Never throws — extraction failure yields no rules, and a mood with
 * no rules still works through its prose text.
 */
export async function extractMoodRules(
  provider: LlmProvider,
  moodText: string,
): Promise<PreferenceRule[]> {
  try {
    const raw = await provider.generate(buildMoodExtractionPrompt(moodText));
    return resolveRules(parseRulesJson(raw), [moodText]);
  } catch {
    return [];
  }
}
