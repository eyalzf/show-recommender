import { ApiError } from './types';
import type { ListItem, Profile, SearchHit, ShowDetail, UiLang } from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      String(body['error'] ?? 'request_failed'),
      String(body['message'] ?? `Request failed (HTTP ${res.status})`),
      res.status,
    );
  }
  return body as T;
}

export const api = {
  health: () => req<{ ok: boolean; dbBound: boolean; aiBound: boolean; tmdbConfigured: boolean }>('/api/health'),

  search: (q: string, lang: UiLang) =>
    req<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&lang=${lang}`),

  show: (tmdbId: number, lang: UiLang) =>
    req<{ show: ShowDetail }>(`/api/shows/${tmdbId}?lang=${lang}`),

  profiles: () => req<{ profiles: Profile[]; stub?: boolean }>('/api/profiles'),

  lists: (profileId: string) =>
    req<{ stub?: boolean; updatedAt: string | null; casual: ListItem[]; deep: ListItem[]; shortReason: string | null }>(
      `/api/lists?profileId=${encodeURIComponent(profileId)}`,
    ),

  feedback: (profileId: string, tmdbId: number, rating: string, reason: string) =>
    req<{ ok: true }>('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ profileId, tmdbId, rating, reason }),
    }),

  deny: (profileId: string, tmdbId: number) =>
    req<{ ok: true }>('/api/deny', {
      method: 'POST',
      body: JSON.stringify({ profileId, tmdbId }),
    }),

  taste: (profileId: string, lang: UiLang) =>
    req<{
      stub?: boolean;
      summary: string;
      summaryLanguage: string;
      notes: { id: string; kind: string; text: string; createdAt: number }[];
      contradiction: { oldText: string; newText: string; proposedMerge: string } | null;
      languageConflict: { praisedLanguage: string; message: string } | null;
      profile?: Profile;
    }>(`/api/taste?profileId=${encodeURIComponent(profileId)}&lang=${lang}`),

  consolidate: (profileId: string, lang: UiLang) =>
    req<{ summary: string; provider: string; stub?: boolean }>('/api/taste/consolidate', {
      method: 'POST',
      body: JSON.stringify({ profileId, lang }),
    }),

  recommendations: (profileId: string) =>
    req<{
      stub?: boolean;
      inbox: { id: string; showTitle: string; kind: string; names: string[]; note: string; outcome: string | null; retrospective: boolean }[];
      peopleRanking: { name: string; recommended: number; liked: number; disliked: number; dropped: number }[];
      knownNames: string[];
    }>(`/api/recommendations?profileId=${encodeURIComponent(profileId)}`),

  addRecommendation: (profileId: string, showTitle: string, kind: string, names: string[], note: string) =>
    req<{ ok: true; id: string }>('/api/recommendations', {
      method: 'POST',
      body: JSON.stringify({ profileId, showTitle, kind, names, note }),
    }),

  adhoc: (profileId: string, query: string, lang: UiLang) =>
    req<{ result: { tmdbId: number; title: string; originalLanguage: string; firstAirDate: string; rationale: string }; provider: string }>(
      '/api/adhoc',
      { method: 'POST', body: JSON.stringify({ profileId, query, lang }) },
    ),
};
