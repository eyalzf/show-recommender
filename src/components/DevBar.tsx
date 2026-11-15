import { t } from '../i18n';
import type { UiLang } from '../types';

/**
 * Dev-deployment bar — rendered ONLY when the Worker reports dev=true
 * via /api/health (see App). Same bundle serves production, where this
 * component never mounts. The dev Worker is mock-only: the banner
 * states that, and there is deliberately no provider switch anywhere
 * (the per-request override path was removed by decision, 19:15 IST) —
 * the provider is fixed by the Worker's env flag.
 */
export function DevBar({ lang, serverProvider }: { lang: UiLang; serverProvider: string }) {
  return (
    <div className="dev-wrap" role="note" aria-label="DEV">
      <div className="dev-banner">{t(lang, 'devBanner')}</div>
      <div className="dev-bar">
        <span className="dev-meta muted">
          {t(lang, 'devMockNote')} ({serverProvider})
        </span>
      </div>
      <div className="dev-watermark" aria-hidden="true">
        DEV
      </div>
    </div>
  );
}
