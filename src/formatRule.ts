import type { PreferenceRule } from './api';
import { t } from './i18n';
import type { UiLang } from './types';

/**
 * One derived preference rule, rendered read-only: a mode prefix
 * ("Never" / "Only" / "Prefer no" / "Prefer") plus the dimension
 * value. Shared by the Preferences "Active rules" block and the
 * Mood sheet's per-mood rule summaries.
 */
export function formatRule(
  lang: UiLang,
  rule: PreferenceRule,
  genreLabels: Record<string, string>,
): string {
  const cmp = rule.operator === 'gte' ? '≥' : '≤';
  const body = (() => {
    switch (rule.dimension) {
      case 'genre':
        return genreLabels[String(rule.value)] ?? String(rule.value);
      case 'year':
        return `${t(lang, 'ruleYear')} ${cmp} ${rule.value}`;
      case 'country':
        return `${t(lang, 'ruleCountry')} ${rule.value}`;
      case 'status':
        return `${t(lang, 'ruleStatus')} ${rule.value}`;
      case 'seasons':
        return `${t(lang, 'ruleSeasons')} ${cmp} ${rule.value}`;
      case 'episodeMinutes':
        return `${t(lang, 'ruleEpisodeMinutes')} ${cmp} ${rule.value} ${t(lang, 'ruleMinutes')}`;
    }
  })();
  const prefix =
    rule.mode === 'hard'
      ? rule.operator === 'isNot'
        ? t(lang, 'ruleNever')
        : t(lang, 'ruleOnly')
      : rule.operator === 'isNot'
        ? t(lang, 'rulePreferNo')
        : t(lang, 'rulePrefer');
  return `${prefix}: ${body}`;
}
