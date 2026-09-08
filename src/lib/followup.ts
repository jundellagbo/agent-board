import { parseChecklist } from "./checklist.ts";

/**
 * Adds a follow-up instruction to a card that has no agent to tell.
 *
 * A card whose body is a checklist gets another step; anything else gets a new
 * paragraph. Appending prose to a checklist would stop every line being a list
 * item, and the card would quietly lose its checkboxes.
 */
export function withFollowUp(body: string | null, followUp: string): string {
  const text = followUp.trim();
  if (text === "") return body ?? "";

  const existing = (body ?? "").trimEnd();
  if (existing === "") return text;

  return parseChecklist(existing).length > 0
    ? `${existing}\n- [ ] ${text}`
    : `${existing}\n\n${text}`;
}
