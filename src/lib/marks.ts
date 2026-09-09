import { stripAnsi } from "./approval.ts";

/**
 * Takes an agent's own decoration off a line of its output.
 *
 * The board's marks are matched at the start of a line, so that an agent
 * quoting its instructions back does not fire them. Agents draw their output
 * inside a box and put a bullet in front of every line of it, which means the
 * mark is never at the start of anything and was never seen at all — the card
 * then sat there until the idle sweep gave up on it 45 seconds later.
 *
 * List markers are deliberately left alone: a plan's body is read through here
 * too, and stripping its bullets would stop it parsing as a checklist.
 */
const EDGE = "[\\s|│┃┆┇┊┋║█]";
const BULLET = "[>❯⏺●○•·∙▸▶]";
const DECORATION = new RegExp(`^(?:${EDGE}|${BULLET})+|${EDGE}+$`, "g");

export function undecorate(line: string): string {
  return line.replace(DECORATION, "").trim();
}

/** The output as lines, with escape codes and that decoration off both ends. */
export function markLines(output: string): string[] {
  return stripAnsi(output).split("\n").map(undecorate);
}

/**
 * What follows a mark on its line, or null when the line is not that mark.
 *
 * The marks are named in the instructions the agent is given, and an agent's
 * transcript shows those instructions back — wrapped to the terminal's width.
 * A wrap landing just before "AGENT-BOARD: DONE" produces a line that starts
 * with the mark and goes on "…on its own line", which a prefix test reads as
 * the agent announcing it had finished before it had started. So the rest of
 * the line has to be empty (an outcome) or a bare number (a step).
 */
export function markPayload(line: string, mark: string): string | null {
  if (!line.startsWith(mark)) return null;
  return line
    .slice(mark.length)
    .replace(/[.!,;:]+$/, "")
    .trim();
}
