"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Input } from "./ui";
import { plugins as pluginApi } from "@/lib/ipc";
import type { Plugin } from "@/lib/types";

// The marketplaces offer hundreds; showing all of them is a wall, so the list
// is what you have plus what you searched for.
const SHOWN = 25;

export function PluginSettings() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setPlugins(await pluginApi.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggle(plugin: Plugin) {
    setBusy(plugin.id);
    try {
      if (plugin.installed) await pluginApi.uninstall(plugin.id);
      else await pluginApi.install(plugin.id);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(null);
    await reload();
  }

  const needle = query.trim().toLowerCase();
  const matches = plugins.filter((plugin) =>
    needle === ""
      ? plugin.installed
      : `${plugin.name} ${plugin.id} ${plugin.description}`.toLowerCase().includes(needle),
  );
  const shown = matches.slice(0, SHOWN);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Plugins</h2>
        <p className="text-xs text-muted-foreground">
          Installed through the agent CLI, like the servers above. Search to reach the ones the
          marketplaces offer.
        </p>
      </div>

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${plugins.length || ""} plugins`}
      />

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {loading && <p className="text-xs text-muted-foreground">Asking the agent CLI…</p>}

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {!loading && shown.length === 0 && (
          <li className="bg-card px-3 py-2 text-xs text-muted-foreground">
            {needle === "" ? "No plugins installed yet — search to find some." : `Nothing matches “${query}”.`}
          </li>
        )}

        {shown.map((plugin) => (
          <li key={plugin.id} className="flex items-center gap-3 bg-card px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm">
                {plugin.name}
                {plugin.installed && (
                  <span
                    className={`rounded px-1 text-xs font-medium ${
                      plugin.enabled
                        ? "bg-primary/15 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {plugin.enabled ? "installed" : "disabled"}
                  </span>
                )}
                {plugin.version && (
                  <span className="font-mono text-xs text-muted-foreground">{plugin.version}</span>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground" title={plugin.description}>
                {plugin.description || plugin.id}
              </p>
            </div>
            <Button
              size="sm"
              variant={plugin.installed ? "destructive" : "default"}
              disabled={busy !== null || loading}
              onClick={() => void toggle(plugin)}
            >
              {busy === plugin.id ? "…" : plugin.installed ? "Remove" : "Install"}
            </Button>
          </li>
        ))}
      </ul>

      {matches.length > shown.length && (
        <p className="text-xs text-muted-foreground">
          {matches.length - shown.length} more match “{query}”. Keep typing to narrow it down.
        </p>
      )}
    </section>
  );
}
