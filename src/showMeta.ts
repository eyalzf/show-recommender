import type { UiLang } from './types';
import { t } from './i18n';

/**
 * Shared show-metadata formatting for rail cards and the detail view:
 * years played, season count, episode count — one compact line.
 * Still-running shows show NO end year (open-ended, e.g. "2015–").
 * Season/episode counts already exclude season 0 (specials) server-side.
 */

/** "2015–2023", "2015–" when ongoing, "2015" for a single year, "" when unknown. */
export function yearRangeLabel(
  firstYear: number | null | undefined,
  lastYear: number | null | undefined,
  ongoing: boolean,
): string {
  if (!firstYear) return '';
  if (ongoing) return `${firstYear}–`;
  if (lastYear && lastYear !== firstYear) return `${firstYear}–${lastYear}`;
  return `${firstYear}`;
}

/** Compact meta line: "2015–2023 · 5 seasons · 62 episodes". Absent parts are omitted. */
export function cardMetaLine(
  lang: UiLang,
  meta: {
    firstYear?: number | null;
    lastYear?: number | null;
    status?: string;
    seasons?: number;
    episodes?: number;
  },
): string {
  const parts: string[] = [];
  const years = yearRangeLabel(meta.firstYear, meta.lastYear, meta.status === 'ongoing');
  if (years) parts.push(years);
  if (meta.seasons && meta.seasons > 0) parts.push(`${meta.seasons} ${t(lang, 'seasons')}`);
  if (meta.episodes && meta.episodes > 0) parts.push(`${meta.episodes} ${t(lang, 'episodes')}`);
  return parts.join(' · ');
}
