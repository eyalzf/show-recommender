export type UiLang = 'en' | 'he';
export type Rating = 'liked' | 'disliked' | 'dropped';

/** Taste summary sections: Shared applies to both lists; Casual/Deep focus are mode-scoped. */
export type TasteSectionKey = 'shared' | 'casual' | 'deep';

export interface TasteSections {
  shared: string;
  casual: string;
  deep: string;
}

/** A contradiction flagged by consolidation — always scoped to one section. */
export interface TasteContradiction {
  scope: TasteSectionKey;
  oldText: string;
  newText: string;
  proposedMerge: string;
}
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
  originalTitle: string;
  voteAverage: number;
  type: string;
  genres: string[];
  tone: string;
  pace: string;
  structure: string;
  episodeMinutes: number;
  seasons: number;
  /** Total episodes, excluding season 0 (specials). */
  episodes: number;
  /** First air year, or null when unknown. */
  firstYear: number | null;
  /** Last air year, or null when unknown; ignored for ongoing shows (open-ended). */
  lastYear: number | null;
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
  /** Last air date; empty for shows that have not aired yet. */
  lastAirDate: string;
  genres: string[];
  originCountry: string[];
  originLabel: string | null;
  status: string | null;
  numberOfSeasons: number | null;
  numberOfEpisodes: number | null;
  episodeRunTime: number[] | null;
  providers: string[];
  /** Top-billed cast (capped server-side); [] when unavailable. */
  cast: CastMember[];
}

/** One cast member on the show detail rail: actor, role, photo. */
export interface CastMember {
  tmdbId: number;
  name: string;
  character: string;
  profilePath: string | null;
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
