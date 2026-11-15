import type { D1Database } from '@cloudflare/workers-types';
import { loadProfileContext, matchFeedbackForShow } from './db';

/**
 * People trust — DERIVED ONLY, never user-set (spec §6).
 *
 * Simple counts for v1: per person, how many shows they recommended and
 * how many of those the profile later liked / disliked / dropped.
 * Ranking weights are undecided, so the frontend shows raw counts and
 * the ranking order is: most liked first, then most recommended.
 *
 * Matching is by TMDB id when the recommendation captured one, else by
 * normalized title. Retrospective entry scores immediately: a rec added
 * for a show the profile already rated is credited on the spot, because
 * recompute always reads the full feedback log.
 *
 * The deny_list is never read here: a "No Reason" remove is not a
 * verdict on the recommender.
 */

export interface PersonScore {
  name: string;
  recommended: number;
  liked: number;
  disliked: number;
  dropped: number;
}

export async function recomputePeopleScores(db: D1Database, profileId: string): Promise<PersonScore[]> {
  const ctx = await loadProfileContext(db, profileId, 'en');
  if (!ctx) return [];

  const byPerson = new Map<string, PersonScore>();
  for (const rec of ctx.externalRecs) {
    if (rec.kind !== 'personal') continue;
    const outcome = matchFeedbackForShow(ctx.showFeedback, rec.tmdbId, rec.showTitle);
    for (const name of rec.names) {
      const score = byPerson.get(name) ?? { name, recommended: 0, liked: 0, disliked: 0, dropped: 0 };
      score.recommended++;
      if (outcome?.rating === 'liked') score.liked++;
      else if (outcome?.rating === 'disliked') score.disliked++;
      else if (outcome?.rating === 'dropped') score.dropped++;
      byPerson.set(name, score);
    }
  }

  const scores = [...byPerson.values()].sort(
    (a, b) => b.liked - a.liked || b.recommended - a.recommended || a.name.localeCompare(b.name),
  );

  // Refresh the cache table (cheap; recompute is the source of truth).
  await db.prepare('DELETE FROM people_scores WHERE profile_id = ?').bind(profileId).run();
  for (const s of scores) {
    await db
      .prepare(
        'INSERT INTO people_scores (profile_id, person_name, recommended, liked, disliked, dropped, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(profileId, s.name, s.recommended, s.liked, s.disliked, s.dropped, Date.now())
      .run();
  }
  return scores;
}

/** All names this profile has ever recorded, for auto-fill. */
export async function loadKnownNames(db: D1Database, profileId: string): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT DISTINCT rp.person_name AS name FROM recommendation_people rp
       JOIN external_recommendations er ON er.id = rp.recommendation_id
       WHERE er.profile_id = ? ORDER BY rp.person_name`,
    )
    .bind(profileId)
    .all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}
