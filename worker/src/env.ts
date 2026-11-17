import type { Ai, D1Database, R2Bucket } from '@cloudflare/workers-types';

/**
 * Worker environment bindings (see wrangler.toml).
 *
 * DB and PROFILE_ICONS are optional at runtime: the D1 database could not be
 * created with the available API token scope (see wrangler.toml note), so the
 * code must degrade gracefully when a binding is absent instead of crashing.
 * Every route that needs the DB returns a clear `database_not_configured`
 * error (or clearly-marked stub data for reads) when env.DB is missing.
 */
export interface Env {
  /** D1 database. Absent until the database is created and bound. */
  DB?: D1Database;
  /** R2 bucket for profile icons/images. */
  PROFILE_ICONS?: R2Bucket;
  /** Workers AI binding (LLM layer). */
  AI?: Ai;
  /** TMDB API v4 read access token (Bearer). Worker secret; never committed. */
  TMDB_READ_TOKEN?: string;
  ENVIRONMENT?: string;
  /**
   * LLM provider selector. `'mock'` enables the deterministic mock
   * provider (worker/src/mockLlm.ts) for quota-free development and
   * verification. Anything else (including unset) means the real
   * Workers AI provider. NEVER set this in production bindings —
   * see deploy/README.md. The dev Worker sets it to 'mock'.
   */
  LLM_PROVIDER?: string;
  /**
   * Chat-model override for the real provider (a Workers AI model id).
   * Unset = the production default (Llama 3.3 70B). A local-run knob
   * only — set on neither Worker (see docs/dev-verification.md).
   * This is the CONSOLIDATION model; ranking uses LLM_RANK_MODEL
   * when set, else this model (see llm.resolveRankModel).
   */
  LLM_MODEL?: string;
  /**
   * Ranking-model override for the real provider (a Workers AI model
   * id): list ranking, the removal check, and ad-hoc rationales.
   * Unset = the consolidation model above. SET IN PRODUCTION
   * bindings (deploy/bindings.json) to the 8B model per the
   * 2026-11-17 benchmark decision (split model: 70B consolidates,
   * 8B ranks). Never set on the dev Worker — dev is mock-only and
   * the var is inert there.
   */
  LLM_RANK_MODEL?: string;
  /**
   * Embedding-model override for the real provider. Unset = BGE-M3.
   * A local-run knob only — set on neither Worker.
   */
  EMBEDDING_MODEL?: string;
  /**
   * `'true'` ONLY on the dev Worker (show-recommender-dev). Drives
   * the DEV banner in the UI (via /api/health). It gates nothing
   * else — there is no per-request override path. Never set in
   * production bindings.
   */
  IS_DEV_WORKER?: string;
}
