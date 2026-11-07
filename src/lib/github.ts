import { splitCard } from "./compose.ts";
import { tasks as taskApi } from "./ipc.ts";
import type { TaskPatch } from "./types";

// Matches what the Rust parser accepts, so the composer can tell a link from a
// sentence before making a round trip.
const GITHUB_REFERENCE = /(?:github\.com\/)?[\w.-]+\/[\w.-]+\/(?:issues|pulls?)\/\d+/i;

export function looksLikeGithub(input: string): boolean {
  return GITHUB_REFERENCE.test(input.trim());
}

// Builds the card a pasted link should become. Falls back to the raw text as a
// title when the link cannot be resolved, so a card is never lost.
export async function cardFromInput(input: string): Promise<TaskPatch> {
  const text = input.trim();
  if (!looksLikeGithub(text)) return splitCard(text);

  const resolved = await taskApi.resolveGithub(text).catch(() => null);
  const reference = resolved?.reference;
  if (!reference) return splitCard(text);

  return {
    title: resolved?.title ?? `${reference.kind === "pull" ? "PR" : "Issue"} #${reference.number}`,
    body: resolved?.body ?? null,
    githubUrl: reference.url,
    githubKind: reference.kind,
    githubNumber: reference.number,
    // A pull request checks out the branch it has; an issue is named after what
    // it is and its number, e.g. `bug-42` — both come back resolved.
    branch: resolved?.branch ?? null,
  };
}
