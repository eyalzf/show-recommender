/**
 * STUB DATA — clearly-marked demo payloads used ONLY while the D1 database
 * is unbound (or a feature is not yet implemented). Every stub response is
 * flagged `stub: true` so the frontend can label it as demo data.
 *
 * Show titles here are real shows used to make the screens readable; no
 * viewing data is real (spec §1). Delete this module once the DB-backed
 * paths cover every route.
 */

export const STUB_PROFILE = {
  id: 'dev-profile-1',
  accountId: 'dev-account-1',
  name: 'Eyal & Wife',
  iconKind: 'initials',
  iconRef: null as string | null,
  languages: ['he', 'en', 'es'],
  uiLanguage: 'en',
  noteCount: 3,
  listsUpdatedAt: null as string | null,
};

export const STUB_PROFILES = [STUB_PROFILE];

export interface StubListItem {
  rank: number;
  tmdbId: number;
  title: string;
  type: 'series' | 'limited' | 'docuseries' | 'reality';
  genres: string[];
  tone: string;
  pace: string;
  structure: 'serialized' | 'episodic';
  episodeMinutes: number;
  seasons: number;
  totalHours: number;
  language: string;
  country: string;
  status: 'ongoing' | 'ended';
  rationale: string;
  risk: string | null;
  posterPath: string | null;
}

export const STUB_CASUAL: StubListItem[] = [
  {
    rank: 1, tmdbId: 0, title: 'Kupa Rashit', type: 'series',
    genres: ['Comedy'], tone: 'Warm', pace: 'Brisk', structure: 'episodic',
    episodeMinutes: 25, seasons: 4, totalHours: 20, language: 'Hebrew', country: 'IL',
    status: 'ongoing',
    rationale: 'Warm workplace humour like the comedies you rated highly.',
    risk: null, posterPath: null,
  },
  {
    rank: 2, tmdbId: 0, title: 'A gentle British mystery', type: 'series',
    genres: ['Mystery'], tone: 'Cosy', pace: 'Steady', structure: 'episodic',
    episodeMinutes: 45, seasons: 2, totalHours: 12, language: 'English', country: 'UK',
    status: 'ended',
    rationale: 'Self-contained cases; echoes your liked detective pick.',
    risk: null, posterPath: null,
  },
];

export const STUB_DEEP: StubListItem[] = [
  {
    rank: 1, tmdbId: 0, title: 'Tehran', type: 'series',
    genres: ['Thriller', 'Drama'], tone: 'Tense', pace: 'Fast', structure: 'serialized',
    episodeMinutes: 45, seasons: 3, totalHours: 24, language: 'Hebrew', country: 'IL',
    status: 'ongoing',
    rationale: 'Tension in the mode of Fauda, which you both rated highly.',
    risk: 'Serialized — not a skip-an-episode show.', posterPath: null,
  },
];

export const STUB_TASTE = {
  summary:
    'We love Israeli and British drama with dry humour and moral grey areas. ' +
    'In Spanish we only watch drama, never comedies. We drop anything bleak ' +
    'without relief, and prefer episodes under 50 minutes on weeknights.',
  summaryLanguage: 'en',
  notes: [
    { id: 'n1', kind: 'like', text: 'More workplace comedies', createdAt: Date.now() - 86400000 },
    { id: 'n2', kind: 'dislike', text: 'No medical dramas', createdAt: Date.now() - 43200000 },
    { id: 'n3', kind: 'like', text: 'Loved the slow burn of the last pick', createdAt: Date.now() - 3600000 },
  ],
  contradiction: {
    oldText: 'We avoid slow-paced shows.',
    newText: 'Loved the slow burn of the last pick.',
    proposedMerge: 'Slow is fine when the dialogue carries it.',
  },
  languageConflict: {
    praisedLanguage: 'Korean',
    message: 'Taste praises Korean drama, but Korean is not in the language filter.',
  },
};

export const STUB_RECOMMENDATIONS = {
  inbox: [
    {
      id: 'r1', showTitle: 'On the Spectrum', kind: 'personal',
      names: ['Maya', 'Noa'], note: 'You two have to watch this.',
      outcome: 'liked', retrospective: true,
    },
    {
      id: 'r2', showTitle: 'A Scandinavian crime series', kind: 'generic',
      names: [], note: 'Podcast top-10 list.',
      outcome: null, retrospective: false,
    },
  ],
  peopleRanking: [
    { name: 'Maya', recommended: 5, liked: 4, disliked: 0, dropped: 1 },
    { name: 'Noa', recommended: 3, liked: 2, disliked: 1, dropped: 0 },
  ],
  knownNames: ['Maya', 'Noa'],
};
