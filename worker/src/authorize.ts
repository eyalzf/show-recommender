import type { Context } from 'hono';
import type { Env } from './env';
import { getAuth } from './auth';

/**
 * Per-profile authorization, enforced server-side on every profile-scoped
 * route (spec build rule 1: every read and write is scoped to the active
 * profile; nothing leaks between profiles).
 *
 * D1 has no row-level security, so this check is app-level and mandatory:
 * a profile may only be read/written when it belongs to the authed account.
 *
 * In stub mode (no DB bound) only the single dev profile is addressable.
 */
export const DEV_PROFILE_ID = 'dev-profile-1';

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message = 'profile does not belong to the current account') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/**
 * Throws AuthorizationError unless `profileId` belongs to the authed account.
 * Call at the top of every profile-scoped handler, before any data access.
 */
export async function requireProfileAccess(
  c: Context<{ Bindings: Env }>,
  profileId: string,
): Promise<void> {
  const auth = getAuth(c);
  const db = c.env.DB;
  if (!db) {
    // Stub mode: only the dev profile exists, and it belongs to the dev account.
    if (auth.accountId === 'dev-account-1' && profileId === DEV_PROFILE_ID) return;
    throw new AuthorizationError();
  }
  const row = await db
    .prepare('SELECT account_id FROM profiles WHERE id = ?')
    .bind(profileId)
    .first<{ account_id: string }>();
  if (!row || row.account_id !== auth.accountId) {
    throw new AuthorizationError();
  }
}

/** Whether the D1 binding is present (routes use this to pick DB vs stub). */
export function hasDb(c: Context<{ Bindings: Env }>): boolean {
  return Boolean(c.env.DB);
}
