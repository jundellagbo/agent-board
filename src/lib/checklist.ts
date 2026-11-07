export interface Step {
  text: string;
  done: boolean;
}

// A numbered list, a bulleted one, or a markdown checkbox — people write the
// same intent all three ways and none of them should need explaining.
const STEP = /^\s*(?:[-*+]\s+)?(?:\d+[.)]\s+)?(?:\[( |x|X)\]\s+)?(.*\S)\s*$/;
const MARKER = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;

/**
 * Reads a card's body as a list of steps, but only when it actually is one:
 * a paragraph of prose is a description, not a checklist, and turning it into
 * one would put a progress bar on every card.
 */
export function isChecklistLine(line: string): boolean {
  return MARKER.test(line) || /^\s*\[( |x|X)\]/.test(line);
}

export function parseChecklist(body: string | null): Step[] {
  const lines = (body ?? "").split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  // Every line has to be a list item — that is what separates a checklist from
  // a paragraph. One item is still a list; the count is not the signal.
  if (!lines.every((line) => MARKER.test(line) || /^\s*\[( |x|X)\]/.test(line))) return [];

  return lines.flatMap((line) => {
    const match = STEP.exec(line);
    if (!match) return [];
    return [{ text: match[2], done: match[1] === "x" || match[1] === "X" }];
  });
}
