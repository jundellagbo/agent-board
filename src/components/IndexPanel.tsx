"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Input } from "./ui";
import { index as indexApi, type SearchHit } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import type { Project } from "@/lib/types";

export function IndexPanel({ project }: { project: Project }) {
  const { refresh } = useStore();
  const [files, setFiles] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const countFiles = useCallback(() => {
    void indexApi
      .files(project.id)
      .then(setFiles)
      .catch(() => setFiles(0));
  }, [project.id]);

  useEffect(() => {
    countFiles();
    setHits(null);
    setQuery("");
  }, [countFiles]);

  useEffect(() => {
    const unlisten = indexApi.onFinished((status) => {
      if (status.projectId !== project.id) return;
      setFiles(status.files);
      setError(status.message);
      void refresh();
    });
    return () => void unlisten.then((stop) => stop());
  }, [project.id, refresh]);

  const indexing = project.indexStatus === "indexing";
  const indexed = project.indexStatus === "indexed";

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    await refresh();
    countFiles();
  }

  async function search() {
    if (query.trim() === "") return;
    try {
      setHits(await indexApi.search(project.id, query, 25));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setHits([]);
    }
  }

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Index</h2>
          <p className="text-xs text-muted-foreground">
            {indexing
              ? "Reading the project…"
              : indexed
                ? `${files.toLocaleString()} files indexed for search.`
                : "Index the project to search it from a card."}
          </p>
        </div>

        {indexed ? (
          <Button size="sm" variant="destructive" onClick={() => void run(() => indexApi.remove(project.id))}>
            Remove from index
          </Button>
        ) : (
          <Button size="sm"
            variant="default"
            disabled={indexing}
            onClick={() => void run(() => indexApi.build(project.id))}
          >
            {indexing ? "Indexing…" : "Index project"}
          </Button>
        )}
      </header>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {indexed && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the indexed files"
          />
          {hits && (
            <ul className="scroll-pane max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border py-2">
              {hits.length === 0 && <li className="text-xs text-muted-foreground">No matches.</li>}
              {hits.map((hit) => (
                <li key={hit.path} className="text-xs">
                  <p className="font-mono text-foreground">{hit.path}</p>
                  <p className="truncate text-muted-foreground">{hit.snippet}</p>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
    </section>
  );
}
