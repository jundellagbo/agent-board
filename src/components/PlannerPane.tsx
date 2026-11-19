"use client";

import { CheckIcon, CopyIcon, FilePlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { Button, Input } from "./ui";
import { planner as plannerApi } from "@/lib/ipc";
import type { PlanFile } from "@/lib/types";

// CodeMirror measures the DOM as it mounts, so it is never prerendered.
const PlanEditor = dynamic(() => import("./PlanEditor").then((module) => module.PlanEditor), {
  ssr: false,
});

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function NoteRow({
  file,
  selected,
  onSelect,
  onRename,
  onRemove,
}: {
  file: PlanFile;
  selected: boolean;
  onSelect: () => void;
  onRename: (to: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // A second click confirms: a browser confirm() would block the webview.
  const [arming, setArming] = useState(false);

  async function copyPath() {
    await navigator.clipboard.writeText(file.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  if (renaming !== null) {
    return (
      <li className="px-1 py-1">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onRename(renaming).then(() => setRenaming(null));
          }}
        >
          <Input
            autoFocus
            value={renaming}
            onChange={(event) => setRenaming(event.target.value)}
            onBlur={() => setRenaming(null)}
            onKeyDown={(event) => event.key === "Escape" && setRenaming(null)}
            className="h-7 font-mono text-xs"
          />
        </form>
      </li>
    );
  }

  return (
    <li
      className={`group flex items-center gap-1 rounded-md px-2 py-1 ${
        selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 truncate text-left font-mono text-xs"
        title={file.path}
      >
        {file.name}
      </button>
      <Button size="icon-xs" variant="ghost" title="Copy path" onClick={() => void copyPath()}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        title="Rename"
        onClick={() => setRenaming(file.name.replace(/\.md$/i, ""))}
      >
        <PencilIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        title={arming ? "Click again to delete" : "Delete"}
        className={arming ? "text-destructive" : "hover:text-destructive"}
        onBlur={() => setArming(false)}
        onClick={() => (arming ? void onRemove() : setArming(true))}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

/** Markdown notes kept outside every repo, whose paths are handed to agents as planning references. */
export function PlannerPane() {
  const [files, setFiles] = useState<PlanFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await plannerApi.list());
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await action();
      setError(null);
      return result;
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function create() {
    const file = await attempt(() => plannerApi.create("untitled"));
    if (!file) return;
    await refresh();
    setSelected(file.name);
  }

  async function rename(from: string, to: string) {
    const file = await attempt(() => plannerApi.rename(from, to));
    if (!file) return;
    await refresh();
    if (selected === from) setSelected(file.name);
  }

  async function remove(name: string) {
    await attempt(() => plannerApi.remove(name));
    await refresh();
    if (selected === name) setSelected(null);
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <aside className="flex w-64 shrink-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Plans</h2>
          <Button size="xs" variant="outline" onClick={() => void create()}>
            <FilePlusIcon /> New
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No plans yet. Create one and copy its path into a card or prompt.
          </p>
        ) : (
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {files.map((file) => (
              <NoteRow
                key={file.name}
                file={file}
                selected={file.name === selected}
                onSelect={() => setSelected(file.name)}
                onRename={(to) => rename(file.name, to)}
                onRemove={() => remove(file.name)}
              />
            ))}
          </ul>
        )}
      </aside>

      {selected ? (
        <PlanEditor key={selected} name={selected} onSaved={() => void refresh()} />
      ) : (
        <section className="flex min-w-0 flex-1 items-center justify-center rounded-lg border border-border">
          <p className="text-sm text-muted-foreground">Select a plan to edit it.</p>
        </section>
      )}
    </div>
  );
}
