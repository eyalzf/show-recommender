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
}
