"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Field, Input } from "./ui";
import { mcp as mcpApi } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import type { CatalogItem, McpScope } from "@/lib/types";

export function McpSettings() {
  const { project } = useStore();
  const [scope, setScope] = useState<McpScope>("user");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reading the installed set asks the agent CLI, which health-checks every
  // server. Say so, rather than leaving the panel looking broken.
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<{ name: string; command: string } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await mcpApi.catalog(scope === "project" ? project?.id : null));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [scope, project?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggle(item: CatalogItem) {
    setBusy(item.server);
    try {
      // Removing keys off the server name, so a server the catalog never listed
      // can still be removed from here.
      if (item.installed) await mcpApi.uninstall(item.server, scope, project?.id);
      else await mcpApi.install(item.key, scope, project?.id);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(null);
    await reload();
  }

  async function add() {
    if (!adding) return;
    setBusy(adding.name);
    try {
      await mcpApi.installCustom(adding.name, adding.command, scope, project?.id);
      setAdding(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(null);
    await reload();
  }

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? items.filter((item) =>
        `${item.name} ${item.server} ${item.description}`.toLowerCase().includes(needle),
      )
    : items;

  return (
    <section className="space-y-3">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">MCP servers</h2>
          <p className="text-xs text-muted-foreground">
            Installed through the agent CLI itself, so the board never becomes a second place this
            configuration can drift.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {(["user", "project"] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={option === "project" && !project}
              aria-pressed={scope === option}
              onClick={() => setScope(option)}
              className={`rounded-[calc(var(--radius)-2px)] px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                scope === option ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {option === "user" ? "This machine" : "This project"}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {loading && (
        <p className="text-xs text-muted-foreground">Checking which servers are installed…</p>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search servers"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAdding(adding ? null : { name: "", command: "" })}
        >
          {adding ? "Cancel" : "Add a server"}
        </Button>
      </div>

      {adding && (
        <form
          className="grid gap-3 rounded-lg border border-border bg-card p-3 sm:grid-cols-[12rem_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Field label="Name">
            <Input
              autoFocus
              value={adding.name}
              onChange={(event) => setAdding({ ...adding, name: event.target.value })}
              placeholder="my-server"
            />
          </Field>
          <Field label="Command">
            <Input
              className="font-mono text-xs"
              value={adding.command}
              onChange={(event) => setAdding({ ...adding, command: event.target.value })}
              placeholder="npx -y some-mcp-server"
            />
          </Field>
          <div className="flex items-end">
            <Button
              size="sm"
              type="submit"
              disabled={busy !== null || adding.name.trim() === "" || adding.command.trim() === ""}
            >
              Install
            </Button>
          </div>
        </form>
      )}

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {shown.length === 0 && !loading && (
          <li className="bg-card px-3 py-2 text-xs text-muted-foreground">
            Nothing matches “{query}”.
          </li>
        )}
        {shown.map((item) => (
          <li key={item.server} className="flex items-center gap-3 bg-card px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm">
                {item.name}
                {item.installed && (
                  <span className="rounded bg-primary/15 px-1 text-xs font-medium text-primary">
                    installed
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">{item.description}</p>
            </div>
            <Button size="sm"
              variant={item.installed ? "destructive" : "default"}
              disabled={busy !== null || loading}
              onClick={() => void toggle(item)}
            >
              {busy === item.key ? "…" : item.installed ? "Remove" : "Install"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
