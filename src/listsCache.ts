import type { ListsResponse } from './api';

/**
 * Session cache for fetched recommendation lists, keyed by profile +
 * language + mood. Home unmounts on every navigation (detail, tabs),
 * so without this every return re-fetched and re-showed the loading
 * state; with it, returning is instant and the fetch revalidates
 * silently in the background. Memory-only — a reload refetches.
 */
const cache = new Map<string, ListsResponse>();

export const listsCacheKey = (profileId: string, lang: string, moodId: string): string =>
  `${profileId}|${lang}|${moodId}`;

export function getCachedLists(key: string): ListsResponse | undefined {
  return cache.get(key);
}

export function setCachedLists(key: string, res: ListsResponse): void {
  cache.set(key, res);
}

/**
 * Drop a rated/denied show from every cached list of a profile (all
 * languages, all moods). The server prunes it from every stored list
 * too (see pruneStoredLists), so the cache must not resurrect it when
 * the user navigates back.
 */
export function dropShowFromLists(profileId: string, tmdbId: number): void {
  for (const [key, res] of cache) {
    if (!key.startsWith(`${profileId}|`)) continue;
    const casual = res.casual.filter((i) => i.tmdbId !== tmdbId);
    const deep = res.deep.filter((i) => i.tmdbId !== tmdbId);
    if (casual.length !== res.casual.length || deep.length !== res.deep.length) {
      cache.set(key, { ...res, casual, deep });
    }
  }
}
