// Agents block on a prompt and then sit there. Nothing in the pty tells us that
// — the process is still alive and the exit code has not happened — so the only
// signal available is what the agent just printed.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\u0007]*(?:\u0007|\x1b\\)/g;

/** Escape sequences only — carriage returns survive, so a caller that cares
 *  about redrawn lines can still tell the frames apart. */
export function stripEscapes(text: string): string {
  return text.replace(ANSI, "");
}

export function stripAnsi(text: string): string {
  return stripEscapes(text).replace(/\r/g, "");
}

const PROMPTS: RegExp[] = [
  // "Continue? (y/n)", "Proceed [Y/n]"
  /\((?:y|yes)\s*\/\s*(?:n|no)\)\s*[?:]?\s*$/i,
  /\[(?:y|yes)\s*\/\s*(?:n|no)\]\s*[?:]?\s*$/i,
  // Claude Code and Codex draw a numbered menu with the cursor on the first item.
  /\b1\.\s*yes\b[\s\S]{0,120}\b(?:2|3)\.\s*(?:no|don't|do not)\b/i,
  /\bdo you want to (?:proceed|continue|allow|make this edit|create)\b/i,
  /\b(?:allow|approve) (?:this )?(?:command|tool|edit|change|action)\b[^\n]{0,60}\?/i,
  /\bwaiting for (?:your )?(?:approval|confirmation|input)\b/i,
  /\bpress enter to continue\b/i,
  // Claude Code's own trust prompt, and any menu drawn with a cursor marker
  // against yes/no options — the most common thing an agent stops on.
  /\benter to confirm\b/i,
  /(?:\u276f|>)\s*(?:\d+\.\s*)?(?:yes|no)\b/i,
  // Aider: "Add file to the chat? (Y)es/(N)o"
  /\((?:y|yes)\)\w*\s*\/\s*\((?:n|no)\)/i,
];

/**
 * Reads the screen the agent is showing. Once the question is answered the agent
 * redraws without it, which is what turns the card back to running with no
 * second signal needed.
 *
 * The window covers a whole terminal screen: a confirmation box is drawn well
 * above the input line and its hints, so a smaller window looks past the
 * question entirely.
 */
export function detectApproval(output: string, tailLength = 8000): boolean {
  const tail = stripAnsi(output).slice(-tailLength).trimEnd();
  if (tail === "") return false;
  return PROMPTS.some((pattern) => pattern.test(tail));
}
