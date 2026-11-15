export type UiLang = 'en' | 'he';
export type Rating = 'liked' | 'disliked' | 'dropped';
export type ScreenName =
  | 'picker'
  | 'onboarding'
  | 'home'
  | 'detail'
  | 'taste'
  | 'recommendations'
  | 'adhoc';

/** Bootstrap (onboarding) progress, computed server-side from the feedback log. */
export interface BootstrapStatus {
  rated: number;
  negatives: number;
  hasNote: boolean;
  complete: boolean;
}

export interface Profile {
  id: string;
  name: string;
  iconKind: string;
  iconRef: string | null;
  languages: string[];
  uiLanguage: string;
  noteCount?: number;
  listsUpdatedAt?: string | null;
  /** Absent in stub/demo mode — treated as complete (no gate). */
  bootstrap?: BootstrapStatus;
}

export interface SearchHit {
  tmdbId: number;
  title: string;
  originalTitle: string;
  originalLanguage: string;
  overview: string;
  posterPath: string | null;
  firstAirDate: string;
  originCountry: string[];
  genres: string[];
  voteAverage: number;
  voteCount: number;
}

/** One show-feedback row, newest first (GET /api/feedback). */
export interface ShowFeedbackEntry {
  tmdbId: number | null;
  showTitle: string | null;
  rating: string | null;
  reason: string;
  originalLanguage: string | null;
  createdAt: number;
}

export interface ListItem {
  rank: number;
  tmdbId: number;
  title: string;
  type: string;
  genres: string[];
  tone: string;
  pace: string;
  structure: string;
  episodeMinutes: number;
  seasons: number;
  totalHours: number;
  language: string;
  country: string;
  status: string;
  rationale: string;
  risk: string | null;
  posterPath: string | null;
}

export interface ShowDetail {
  tmdbId: number;
  title: string;
  originalTitle: string;
  originalLanguage: string;
  overview: string;
  source: string;
  autoTranslated: boolean;
  posterPath: string | null;
  firstAirDate: string;
  genres: string[];
  originCountry: string[];
  originLabel: string | null;
  status: string | null;
  numberOfSeasons: number | null;
  numberOfEpisodes: number | null;
  episodeRunTime: number[] | null;
  providers: string[];
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
