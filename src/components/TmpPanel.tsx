"use client";

import { useEffect, useMemo, useState } from "react";

import { AttachmentPreview, AttachmentStrip } from "./Attachments";
import { Button } from "./ui";
import { useAttachments } from "@/lib/attachments";
import { projects as projectApi, tasks as taskApi } from "@/lib/ipc";
import type { TmpFile } from "@/lib/types";

/** Files whose card is gone, or was never created — a composer draft abandoned
 *  before the card was added leaves its attachments behind under the draft id. */
const ORPHANS = "Not on a board";

interface Card {
  title: string;
  project: string;
}

function total(files: TmpFile[]): string {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Everything the cards are carrying, in one place.
 *
 * The store outlives the run that filled it and is easy to forget about, so it
 * is managed here rather than only card by card: what is in it, how much of it
 * there is, and a way to open it where it actually lives.
 */
export function TmpPanel() {
  const { files, error, remove, reveal, clear } = useAttachments();
  const [previewing, setPreviewing] = useState<TmpFile | null>(null);
  const [cards, setCards] = useState<Record<string, Card>>({});

  // The store knows card ids; a person knows the project and the card's name.
  // Every project, not just the one on screen — the store spans all of them, and
  // a file filed under a project you are not looking at is still yours.
  useEffect(() => {
    let current = true;
    void (async () => {
      const found = await projectApi.list().catch(() => []);
      const lists = await Promise.all(found.map((one) => taskApi.list(one.id).catch(() => [])));
      if (!current) return;

      const byCard: Record<string, Card> = {};
      found.forEach((one, index) => {
        for (const task of lists[index]) byCard[task.id] = { title: task.title, project: one.name };
      });
      setCards(byCard);
    })();
    return () => {
      current = false;
    };
  }, []);

  const projects = useMemo(() => {
    const byProject = new Map<string, Map<string, TmpFile[]>>();
    for (const file of files) {
      const name = cards[file.cardId]?.project ?? ORPHANS;
      const group = byProject.get(name) ?? new Map<string, TmpFile[]>();
      byProject.set(name, group);
      group.set(file.cardId, [...(group.get(file.cardId) ?? []), file]);
    }

    // Alphabetical, but whatever no longer belongs to a project sits last: it is
    // the part of the store worth clearing, not the part worth reading.
    return [...byProject.entries()].sort(([a], [b]) =>
      a === ORPHANS ? 1 : b === ORPHANS ? -1 : a.localeCompare(b),
    );
  }, [files, cards]);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Scratch files</h2>
        <p className="text-xs text-muted-foreground">
          What each card was given and what its agent handed back. Kept outside the project, and
          removed with the card.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        projects.map(([name, group]) => (
          <section key={name} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {name}
              </h3>
              <p className="shrink-0 font-mono text-xs text-muted-foreground">
                {total([...group.values()].flat())}
              </p>
            </div>

            <ul className="space-y-3">
              {[...group.entries()].map(([cardId, cardFiles]) => (
                <li key={cardId} className="rounded-lg border border-border bg-card px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm">
                      {cards[cardId]?.title ?? (
                        <span className="font-mono text-xs text-muted-foreground">{cardId}</span>
                      )}
                    </p>
                    <p className="shrink-0 font-mono text-xs text-muted-foreground">
                      {cardFiles.length} · {total(cardFiles)}
                    </p>
                  </div>

                  <AttachmentStrip
                    files={cardFiles}
                    onOpen={setPreviewing}
                    onRemove={(file) => void remove(file.path)}
                  />

                  <div className="mt-1.5 flex gap-2">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void reveal(cardFiles[0].path)}
                    >
                      Show in file manager
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void clear(cardId)}
                    >
                      Remove all
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {previewing && (
        <AttachmentPreview
          file={previewing}
          onClose={() => setPreviewing(null)}
          onRemove={() => void remove(previewing.path)}
          onReveal={() => void reveal(previewing.path)}
        />
      )}
    </section>
  );
}
