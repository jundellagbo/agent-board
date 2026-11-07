/**
 * Absolute paths (Unix or Windows) an agent printed that point at something worth showing on its
 * card — a screenshot, a report. The extension list matches what Rust will
 * agree to collect; anything else is not worth the round trip.
 */
const PATH =
  /(?:^|[\s'"`(<[=:])((?:\/(?!\/)|~\/|[A-Za-z]:[\\/])[^\s'"`()<>[\]]+?\.(?:png|jpe?g|gif|webp|svg|avif|pdf|mp4|webm|mov|md|txt|log|csv|json|html|diff|patch))(?=$|[\s'"`)>\],.;:!?])/gim;

export function mentionedFiles(text: string, home?: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH)) {
    const path = match[1];
    if (path.startsWith("~/")) {
      if (home) found.add(`${home.replace(/\/$/, "")}${path.slice(1)}`);
    } else {
      found.add(path);
    }
  }
  return [...found];
}
