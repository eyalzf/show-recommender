/** Shared profile metadata: hard-filter languages + icon presets. */

export const ALL_LANGUAGES = [
  { code: 'he', labelEn: 'Hebrew', labelHe: 'עברית' },
  { code: 'en', labelEn: 'English', labelHe: 'אנגלית' },
  { code: 'es', labelEn: 'Spanish', labelHe: 'ספרדית' },
  { code: 'ko', labelEn: 'Korean', labelHe: 'קוריאנית' },
  { code: 'fr', labelEn: 'French', labelHe: 'צרפתית' },
  { code: 'de', labelEn: 'German', labelHe: 'גרמנית' },
];

export const ICON_PRESETS = ['🎬', '📺', '🍿', '🎭', '⭐', '❤️'];

export function languageLabel(code: string, lang: 'en' | 'he'): string {
  const found = ALL_LANGUAGES.find((l) => l.code === code);
  if (!found) return code;
  return lang === 'he' ? found.labelHe : found.labelEn;
}
