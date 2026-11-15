import { useState } from 'react';
import type { Rating, UiLang } from '../types';
import { t } from '../i18n';

interface Props {
  lang: UiLang;
  title: string;
  onSubmit: (rating: Rating, reason: string) => void;
  onClose: () => void;
}

/** The one rating dialog, used by show detail and by the Rate quick action. */
export function RatingDialog({ lang, title, onSubmit, onClose }: Props) {
  const [rating, setRating] = useState<Rating>('liked');
  const [reason, setReason] = useState('');
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog">
        <h3>{title}</h3>
        <div className="rating-row" role="group" aria-label={t(lang, 'rate')}>
          {(['liked', 'disliked', 'dropped'] as Rating[]).map((r) => (
            <button
              key={r}
              type="button"
              className={rating === r ? 'btn btn-primary' : 'btn'}
              onClick={() => setRating(r)}
            >
              {t(lang, r)}
            </button>
          ))}
        </div>
        <label className="field-label">
          {t(lang, 'whyOptional')}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t(lang, 'cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onSubmit(rating, reason)}>
            {t(lang, 'saveFeedback')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RemoveProps {
  lang: UiLang;
  title: string;
  onDislike: (reason: string) => void;
  onNoReason: () => void;
  onClose: () => void;
}

/**
 * Remove asks why (spec §7): Dislike folds the reason into taste;
 * No Reason writes ONLY a deny-list entry (never a taste/trust signal).
 */
export function RemoveDialog({ lang, title, onDislike, onNoReason, onClose }: RemoveProps) {
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'ask' | 'dislike'>('ask');
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog">
        <h3>{title}</h3>
        <p>{t(lang, 'removeWhy')}</p>
        {mode === 'ask' ? (
          <div className="dialog-actions-col">
            <button type="button" className="btn" onClick={() => setMode('dislike')}>
              {t(lang, 'removeDislike')}
            </button>
            <button type="button" className="btn" onClick={onNoReason}>
              {t(lang, 'removeNoReason')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {t(lang, 'cancel')}
            </button>
          </div>
        ) : (
          <>
            <label className="field-label">
              {t(lang, 'whyOptional')}
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t(lang, 'cancel')}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => onDislike(reason)}>
                {t(lang, 'saveFeedback')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
