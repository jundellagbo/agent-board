/**
 * Models we can name with confidence, offered as suggestions in the agent
 * editor. The field stays free text: an agent's CLI may accept ids this list
 * has never heard of, and a stale list must never block one.
 */
export const KNOWN_MODELS: { cli: string; models: { id: string; label: string }[] }[] = [
  {
    cli: "claude",
    models: [
      { id: "claude-opus-5", label: "Opus 5 — most capable, the default" },
      { id: "claude-sonnet-5", label: "Sonnet 5 — cheaper, still strong" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest and cheapest" },
      { id: "claude-fable-5-1", label: "Fable 5.1 — hardest reasoning, priciest" },
    ],
  },
];

/** Suggestions for whichever CLI a command template starts with. */
export function modelsFor(command: string): { id: string; label: string }[] {
  const program = command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  return KNOWN_MODELS.find((entry) => entry.cli === program)?.models ?? [];
}
