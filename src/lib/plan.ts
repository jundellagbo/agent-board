import { markLines } from "./marks.ts";

/**
 * Some cards deserve a plan first; most do not. Rather than guess from the
 * wording, the agent decides and says which — and when it does plan, the plan
 * lands on the card as its checklist instead of scrolling past in a terminal.
 */
export const PLAN_START = "AGENT-BOARD: PLAN";
export const PLAN_END = "AGENT-BOARD: END";
export const NO_PLAN = "AGENT-BOARD: NO PLAN";

export const PLAN_INSTRUCTION =
  `Before changing anything, decide whether this card needs a plan. ` +
  `If it is one obvious change, print exactly ${NO_PLAN} on its own line and get on with it. ` +
  `Otherwise print the plan as a numbered list between a line saying exactly ${PLAN_START} ` +
  `and a line saying exactly ${PLAN_END}, then work through it.`;

export type PlanDecision = { type: "none" } | { type: "plan"; body: string };

/**
 * True only between the opening mark and its close — the window in which the
 * agent is genuinely writing a plan. A card that never needs one therefore
 * never wears the label, which is the point: Planning used to be set the moment
 * a card was claimed and stayed there whatever the agent did.
 */
export function planStarted(output: string): boolean {
  const lines = markLines(output);
  const start = lines.findIndex((line) => line === PLAN_START);
  if (start === -1) return false;
  return !lines.some((line, index) => index > start && line === PLAN_END);
}

/** Reads the decision out of the output, or nothing if it has not been made. */
export function detectPlan(output: string): PlanDecision | null {
  const lines = markLines(output);

  const start = lines.findIndex((line) => line === PLAN_START);
  if (start !== -1) {
    const end = lines.findIndex((line, index) => index > start && line === PLAN_END);
    if (end !== -1) {
      const body = lines.slice(start + 1, end).filter(Boolean).join("\n");
      if (body !== "") return { type: "plan", body };
    }
    // A plan that has started but not closed is still being written.
    return null;
  }

  // Matched on its own line so the instruction, which names the mark, does not
  // read as the decision.
  if (lines.some((line) => line === NO_PLAN)) return { type: "none" };
  return null;
}
