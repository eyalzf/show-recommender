export type UiLang = 'en' | 'he';
export type Rating = 'liked' | 'disliked' | 'dropped';
export type ScreenName =
  | 'picker'
  | 'bootstrap'
  | 'home'
  | 'detail'
  | 'taste'
  | 'recommendations'
  | 'adhoc';

export interface Profile {
  id: string;
  name: string;
  iconKind: string;
  iconRef: string | null;
  languages: string[];
  uiLanguage: string;
  noteCount?: number;
  listsUpdatedAt?: string | null;
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
