export interface Draft {
  title: string;
  agentId: string;
  model: string;
}

const KEY = "agent-board.draft.";

/**
 * A half-written card, kept per column so navigating away and back does not
 * throw away what someone was in the middle of typing.
 *
 * Every access is guarded: storage is unavailable in a private window and
 * throws outright in some embeddings, and losing a draft is not worth taking
 * the board down for.
 */
export function readDraft(groupId: string): Draft | null {
  try {
    const raw = localStorage.getItem(KEY + groupId);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<Draft>;
    if (typeof draft.title !== "string" || draft.title.trim() === "") return null;
    return { title: draft.title, agentId: draft.agentId ?? "", model: draft.model ?? "" };
  } catch {
    return null;
  }
}

export function writeDraft(groupId: string, draft: Draft): void {
  try {
    // Nothing typed is not a draft; keeping one would reopen an empty composer.
    if (draft.title.trim() === "") localStorage.removeItem(KEY + groupId);
    else localStorage.setItem(KEY + groupId, JSON.stringify(draft));
  } catch {
    // Storage is a convenience here, never a requirement.
  }
}

export function clearDraft(groupId: string): void {
  try {
    localStorage.removeItem(KEY + groupId);
  } catch {
    // As above.
  }
}
