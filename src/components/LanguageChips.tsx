import { ALL_LANGUAGES } from '../profileMeta';
import { t } from '../i18n';
import type { UiLang } from '../types';

/**
 * Shows-languages picker, shared by onboarding and Preferences so the
 * two never drift. An empty selection means "any language" — the
 * engine treats an empty languages array as no filter — so the Any
 * chip is on exactly when nothing else is selected, and toggling off
 * the last language lands on Any.
 */
export function LanguageChips({
  lang,
  selected,
  onChange,
}: {
  lang: UiLang;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const anySelected = selected.length === 0;
  return (
    <div className="chips">
      <button
        type="button"
        className={anySelected ? 'chip chip-on' : 'chip chip-btn'}
        onClick={() => {
          if (!anySelected) onChange([]);
        }}
        aria-pressed={anySelected}
      >
        {t(lang, 'anyLanguage')}
      </button>
      {ALL_LANGUAGES.map((l) => {
        const on = selected.includes(l.code);
        return (
          <button
            key={l.code}
            type="button"
            className={on ? 'chip chip-on' : 'chip chip-btn'}
            onClick={() =>
              onChange(on ? selected.filter((c) => c !== l.code) : [...selected, l.code])
            }
            aria-pressed={on}
          >
            {lang === 'he' ? l.labelHe : l.labelEn}
          </button>
        );
      })}
    </div>
  );
}
