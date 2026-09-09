/**
 * Whether a session has been still long enough to call finished.
 *
 * Kept apart from the terminal so the rule can be reasoned about on its own:
 * a working agent is never still — its status line counts seconds and its
 * spinner turns — so stillness is the signal, and an agent waiting on an answer
 * is excluded however long it waits.
 *
 * A session showing no status line at all is parked at its own prompt rather
 * than working, and is given a shorter run at it. Stillness is still required:
 * the shorter wait only applies to a screen that has not changed either, so an
 * agent whose status line simply went unrecognised has to have stopped drawing
 * anything for that whole window before it counts.
 */
export function hasGoneIdle(
  session: {
    ready: boolean;
    waiting: boolean;
    /** The agent's own status line, or null when it is showing none. */
    status: string | null;
    settledAt: number;
    closed: boolean;
  },
  now: number,
  after: number,
  parkedAfter = after,
): boolean {
  if (session.closed || !session.ready || session.waiting) return false;
  const wait = session.status === null ? Math.min(parkedAfter, after) : after;
  return now - session.settledAt >= wait;
}
