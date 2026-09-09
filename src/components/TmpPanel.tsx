"use client";

import { useEffect, useMemo, useState } from "react";

import { AttachmentPreview, AttachmentStrip } from "./Attachments";
import { Button } from "./ui";
import { useAttachments } from "@/lib/attachments";
import { tasks as taskApi } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import type { TmpFile } from "@/lib/types";

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
  const { project } = useStore();
  const { files, error, remove, reveal, clear } = useAttachments();
  const [previewing, setPreviewing] = useState<TmpFile | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});

  // Card ids are what the store knows; a title is what a person recognises.
  useEffect(() => {
    if (!project) return;
    void taskApi
      .list(project.id)
      .then((tasks) =>
        setTitles(Object.fromEntries(tasks.map((task) => [task.id, task.title]))),
      )
      .catch(() => undefined);
  }, [project]);

  const cards = useMemo(() => {
    const byCard = new Map<string, TmpFile[]>();
    for (const file of files) {
      const existing = byCard.get(file.cardId);
      if (existing) existing.push(file);
      else byCard.set(file.cardId, [file]);
    }
    return [...byCard.entries()];
  }, [files]);

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

      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ul className="space-y-3">
          {cards.map(([cardId, cardFiles]) => (
            <li key={cardId} className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-sm">
                  {titles[cardId] ?? (
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
                <Button size="xs" variant="ghost" onClick={() => void reveal(cardFiles[0].path)}>
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
