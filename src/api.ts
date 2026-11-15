import { ApiError } from './types';
import type { ListItem, Profile, SearchHit, ShowDetail, ShowFeedbackEntry, TasteContradiction, TasteSections, UiLang } from './types';

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

export interface TasteResponse {
  stub?: boolean;
  summary: string;
  sections: TasteSections;
  summaryLanguage: string;
  notes: { id: string; kind: string; text: string; createdAt: number }[];
  contradiction: TasteContradiction | null;
  languageConflict: { praisedLanguage: string; languageCode?: string; message: string } | null;
  profile?: Profile;
}

export interface ListsResponse {
  stub?: boolean;
  stale?: boolean;
  updatedAt: string | null;
  casual: ListItem[];
  deep: ListItem[];
  shortReason: string | null;
  casualShortReason: string | null;
  deepShortReason: string | null;
}

export const api = {
  health: () => req<{ ok: boolean; dbBound: boolean; aiBound: boolean; tmdbConfigured: boolean }>('/api/health'),

  search: (q: string, lang: UiLang) =>
    req<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&lang=${lang}`),

  quickPicks: (profileId: string, lang: UiLang) =>
    req<{ results: SearchHit[] }>(
      `/api/quick-picks?profileId=${encodeURIComponent(profileId)}&lang=${lang}`,
    ),

  feedbackList: (profileId: string) =>
    req<{ feedback: ShowFeedbackEntry[] }>(
      `/api/feedback?profileId=${encodeURIComponent(profileId)}`,
    ),

  show: (tmdbId: number, lang: UiLang) =>
    req<{ show: ShowDetail }>(`/api/shows/${tmdbId}?lang=${lang}`),

  profiles: () => req<{ profiles: Profile[]; stub?: boolean }>('/api/profiles'),

  createProfile: (name: string, languages: string[], uiLanguage: UiLang, iconKind: string, iconRef: string | null) =>
    req<{ profile: Profile }>('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name, languages, uiLanguage, iconKind, iconRef }),
    }),

  updateProfile: (profileId: string, patch: Partial<Pick<Profile, 'name' | 'languages' | 'uiLanguage' | 'iconKind' | 'iconRef'>>) =>
    req<{ profile: Profile }>(`/api/profiles/${encodeURIComponent(profileId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  uploadIcon: async (profileId: string, file: File): Promise<{ ok: true; iconRef: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/profiles/${encodeURIComponent(profileId)}/icon`, {
      method: 'POST',
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ApiError(
        String(body['error'] ?? 'request_failed'),
        String(body['message'] ?? `Request failed (HTTP ${res.status})`),
        res.status,
      );
    }
    return body as { ok: true; iconRef: string };
  },

  lists: (profileId: string, lang: UiLang, refresh = false) =>
    req<ListsResponse>(
      `/api/lists?profileId=${encodeURIComponent(profileId)}&lang=${lang}${refresh ? '&refresh=1' : ''}`,
    ),

  refreshLists: (profileId: string, lang: UiLang) =>
    req<ListsResponse>('/api/lists/refresh', {
      method: 'POST',
      body: JSON.stringify({ profileId, lang }),
    }),

  feedback: (profileId: string, tmdbId: number, rating: string, reason: string, showTitle?: string, originalLanguage?: string) =>
    req<{ ok: true }>('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ profileId, tmdbId, rating, reason, showTitle, originalLanguage }),
    }),

  deny: (profileId: string, tmdbId: number) =>
    req<{ ok: true }>('/api/deny', {
      method: 'POST',
      body: JSON.stringify({ profileId, tmdbId }),
    }),

  addNote: (profileId: string, kind: 'like' | 'dislike' | 'note', text: string) =>
    req<{ ok: true }>('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ profileId, kind, text }),
    }),

  taste: (profileId: string, lang: UiLang) =>
    req<TasteResponse>(`/api/taste?profileId=${encodeURIComponent(profileId)}&lang=${lang}`),

  updateTaste: (profileId: string, lang: UiLang, sections: TasteSections) =>
    req<{ ok: true }>('/api/taste', {
      method: 'PUT',
      body: JSON.stringify({ profileId, lang, sections }),
    }),

  consolidate: (profileId: string, lang: UiLang) =>
    req<{
      summary: string;
      sections: TasteSections;
      contradictions: TasteContradiction[];
      languageConflict: { languageCode: string; languageName: string; message?: string } | null;
      provider: string;
      stub?: boolean;
    }>('/api/taste/consolidate', {
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
    req<{ result: { tmdbId: number; title: string; originalLanguage: string; firstAirDate: string; posterPath: string | null; genres: string[]; rationale: string }; provider: string }>(
      '/api/adhoc',
      { method: 'POST', body: JSON.stringify({ profileId, query, lang }) },
    ),
};
