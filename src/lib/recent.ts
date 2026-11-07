/**
 * The last few lines of what an agent is actually saying, for a card's preview.
 *
 * An agent's TUI keeps its input box and footer pinned to the bottom of the
 * screen, framed by horizontal rules, so the bottom lines are always the same
 * chrome. Everything from the first rule of that bottom frame down is cut, and
 * what is left above it is the conversation.
 */
const RULE = /^[\s─━═—-]{8,}$/;
const FRAME = 12;

export function recentLines(screen: string, count = 4): string[] {
  const lines = screen.split("\n").map((line) => line.trimEnd());

  let end = lines.length;
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - FRAME); index -= 1) {
    if (RULE.test(lines[index]) && lines[index].trim() !== "") end = index;
  }

  return lines
    .slice(0, end)
    .filter((line) => line.trim() !== "" && !RULE.test(line))
    .slice(-count);
}
