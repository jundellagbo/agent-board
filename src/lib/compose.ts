// A leading slash command, e.g. "/infra-llm-plan plans/fix.md" or "/dir:name".
// A path mentioned mid-sentence is not one, so the match is anchored.
const COMMAND = /^\/([\w.-]+(?::[\w.-]+)?)(?=\s|$)/;

/** The command a line starts with, if it starts with one. */
export function commandName(text: string): string | null {
  const match = COMMAND.exec(text.trim());
  return match ? `/${match[1]}` : null;
}

import { isChecklistLine, parseChecklist } from "./checklist.ts";

/** The words of a list item, without its number or bullet. */
function stepText(line: string): string {
  return parseChecklist(line)[0]?.text ?? line.trim();
}

export interface Composed {
  title: string;
  body: string | null;
}

/**
 * Splits what someone typed into a card. The first line names the work and the
 * rest is its detail — which is what lets a numbered list become the card's
 * checklist instead of a very long title.
 */
export function splitCard(input: string): Composed {
  const lines = input.trim().split("\n");
  const written = lines.filter((line) => line.trim() !== "");

  // A card that is nothing but a list keeps the whole list as its checklist and
  // takes its name from the first step. Peeling the first line off as a title
  // used to cut the list in half, leaving a one-item body that no longer read
  // as a list at all.
  if (written.length > 1 && written.every(isChecklistLine)) {
    return { title: stepText(written[0]), body: written.join("\n") };
  }

  const title = (lines.shift() ?? "").trim();

  // Leading blank lines between the title and the detail are typing, not content.
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();

  const body = lines.join("\n").trimEnd();
  return { title, body: body === "" ? null : body };
}
