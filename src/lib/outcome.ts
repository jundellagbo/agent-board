import { markLines, markPayload } from "./marks.ts";

/**
 * An interactive agent does not exit when it finishes — it returns to its own
 * prompt and waits. Nothing about the process says "the work is done", so the
 * agent has to say it, and the column's instruction asks it to.
 */
export const DONE_MARK = "AGENT-BOARD: DONE";
export const BLOCKED_MARK = "AGENT-BOARD: BLOCKED";

export const SENTINEL_INSTRUCTION =
  `When you have finished, print exactly ${DONE_MARK} on its own line. ` +
  `If you cannot finish — the work is wrong, blocked, or needs a person — print ` +
  `exactly ${BLOCKED_MARK} instead, after saying why.`;

export type Outcome = "done" | "blocked";

/**
 * Reads the outcome the agent announced. The marks are matched at the start of
 * a line so an agent quoting the instruction back (or a card that mentions it)
 * does not end the run.
 */
export function detectOutcome(output: string): Outcome | null {
  const lines = markLines(output).filter(Boolean);

  for (const line of lines.reverse()) {
    if (markPayload(line, BLOCKED_MARK) === "") return "blocked";
    if (markPayload(line, DONE_MARK) === "") return "done";
  }
  return null;
}
