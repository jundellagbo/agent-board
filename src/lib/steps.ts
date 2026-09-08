import { stripAnsi } from "./approval.ts";

/**
 * How an agent says it has finished one item of a card's checklist.
 *
 * Nothing in the output tells us this on its own — "opened the site" could be a
 * plan, a status, or a result — so the agent numbers the step it just finished
 * and the board ticks that box.
 */
export const STEP_MARK = "AGENT-BOARD: STEP";

/** Written without a count for a card whose checklist the agent is about to plan. */
export function stepInstruction(count?: number): string {
  const list =
    count === undefined
      ? "The card's checklist is numbered from 1."
      : `This card has ${count} numbered steps.`;

  return (
    `${list} As you finish each one, print exactly ${STEP_MARK} followed by its ` +
    `number on its own line, so the board can tick it off.`
  );
}

/** The steps announced so far, as zero-based indices, in the order given. */
export function detectSteps(output: string, count = Number.POSITIVE_INFINITY): number[] {
  const seen: number[] = [];

  for (const line of stripAnsi(output).split("\n")) {
    const trimmed = line.trim();
    // Anchored at the start of the line: the instruction names the mark, and
    // agents quote their instructions back constantly.
    if (!trimmed.startsWith(STEP_MARK)) continue;

    const number = Number.parseInt(trimmed.slice(STEP_MARK.length).trim(), 10);
    if (!Number.isInteger(number)) continue;

    const index = number - 1;
    if (index < 0 || index >= count || seen.includes(index)) continue;
    seen.push(index);
  }
  return seen;
}
