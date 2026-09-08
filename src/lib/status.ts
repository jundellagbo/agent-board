import { stripEscapes } from "./approval.ts";

// A spinner glyph, a verb ending in an ellipsis, and often a parenthetical:
//   \u273b Mustering\u2026 (12s \u00b7 \u2193 1.2k tokens \u00b7 esc to interrupt)
const STATUS =
  /^[\s*.\u00b7\u22ef\u2022\u25cf\u2734\u273b\u273d\u2736\u2733\u2722]*([A-Za-z][A-Za-z ]{1,24}(?:\u2026|\.\.\.))\s*(?:\(([^)]*)\))?/;

/**
 * The agent's own status line, so a card can say what is happening without
 * anyone opening its terminal.
 *
 * Agents redraw that line in place with carriage returns, so the raw tail holds
 * every frame glued together. Splitting on carriage returns as well as newlines
 * is what gets the newest frame rather than all of them at once.
 *
 * Agents draw their status above their input box and a couple of hint lines, so
 * the newest match in the recent tail is the current one — looking only at the
 * very last lines finds nothing at all.
 */
export function detectStatus(output: string, frames = 24): string | null {
  const segments = stripEscapes(output)
    .split(/[\r\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(-frames)
    .reverse();

  for (const segment of segments) {
    const match = STATUS.exec(segment);
    if (!match) continue;

    const verb = match[1].trim();
    // Keep the elapsed time; "esc to interrupt" is advice for the terminal, not
    // information for the board.
    const detail = (match[2] ?? "")
      .split("\u00b7")
      .map((part) => part.trim())
      .find((part) => part && !/esc to/i.test(part));

    return detail ? `${verb} (${detail})` : verb;
  }
  return null;
}
