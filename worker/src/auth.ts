import type { Context } from 'hono';

/**
 * AUTH — STUB ONLY (milestone 1).
 *
 * The real auth decision (Clerk free tier vs. sessions in D1) is still OPEN,
 * so there is deliberately NO login, NO password handling, and NO Clerk code
 * in this milestone. Every request is treated as one fixed dev account.
 *
 * The seam for real auth is this module: when auth lands, `resolveAuth`
 * becomes the one place that turns a request into an AuthContext (verify a
 * session cookie / Clerk token, load the account id), and nothing else
 * changes — routes only ever read `c.get('auth')`, and per-profile
 * authorization lives in authorize.ts.
 */
export interface AuthContext {
  /** Account id the request acts as. */
  accountId: string;
  /** True while the dev stub is in place; must be false once real auth lands. */
  stub: true;
}

export const DEV_ACCOUNT_ID = 'dev-account-1';

export function resolveAuth(_c: Context): AuthContext {
  // STUB: single dev account. Replace with session/Clerk verification.
  return { accountId: DEV_ACCOUNT_ID, stub: true };
}

/** Hono middleware: attach the AuthContext to every request. */
export async function authMiddleware(c: Context, next: () => Promise<void>): Promise<void> {
  c.set('auth', resolveAuth(c));
  await next();
}

export function getAuth(c: Context): AuthContext {
  return c.get('auth') as AuthContext;
}
