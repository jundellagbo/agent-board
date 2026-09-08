/**
 * Whether a session has been still long enough to call finished.
 *
 * Kept apart from the terminal so the rule can be reasoned about on its own:
 * a working agent is never still — its status line counts seconds and its
 * spinner turns — so stillness is the signal, and an agent waiting on an answer
 * is excluded however long it waits.
 */
export function hasGoneIdle(
  session: { ready: boolean; waiting: boolean; settledAt: number; closed: boolean },
  now: number,
  after: number,
): boolean {
  if (session.closed || !session.ready || session.waiting) return false;
  return now - session.settledAt >= after;
}
