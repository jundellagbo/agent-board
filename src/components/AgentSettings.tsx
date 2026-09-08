"use client";

import { useEffect, useState } from "react";

import { Combobox } from "./Combobox";
import { Button, Field, Input } from "./ui";
import { modelsFor } from "@/lib/models";
import { agents as agentApi } from "@/lib/ipc";
import type { Agent, AgentPatch } from "@/lib/types";

const BLANK: AgentPatch = { name: "", command: "", model: "" };

export function AgentSettings() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; patch: AgentPatch } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setAgents(await agentApi.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    await reload();
  }

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Agents</h2>
          <p className="text-xs text-muted-foreground">
            A command template per agent. <code className="font-mono">{"{prompt}"}</code>,{" "}
            <code className="font-mono">{"{task}"}</code>,{" "}
            <code className="font-mono">{"{skills}"}</code> and{" "}
            <code className="font-mono">{"{path}"}</code> are filled in when a card runs; an empty
            command opens a plain shell.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditing({ id: null, patch: { ...BLANK } })}>New agent</Button>
      </header>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {agents.map((agent) => (
          <li key={agent.id} className="flex items-center gap-3 bg-card px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm">
                {agent.name}
                {agent.isDefault && (
                  <span className="rounded bg-primary/15 px-1 text-xs font-medium text-primary">
                    default
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {agent.command || "$SHELL"}
              </p>
              {agent.model && (
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {agent.model}
                </p>
              )}
            </div>
            {!agent.isDefault && (
              <Button size="sm" variant="outline" onClick={() => void run(() => agentApi.save(agent.id, { isDefault: true }))}>
                Make default
              </Button>
            )}
            <Button size="sm" variant="outline"
              onClick={() =>
                setEditing({
                  id: agent.id,
                  patch: {
                    name: agent.name,
                    command: agent.command,
                    model: agent.model ?? "",
                  },
                })
              }
            >
              Edit
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void run(() => agentApi.remove(agent.id))}>
              Delete
            </Button>
          </li>
        ))}
      </ul>

      {editing && (
        <form
          className="space-y-3 rounded-lg border border-border bg-card p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => agentApi.save(editing.id, editing.patch));
            setEditing(null);
          }}
        >
          <Field label="Name">
            <input
              autoFocus
              
              value={editing.patch.name ?? ""}
              onChange={(event) =>
                setEditing({ ...editing, patch: { ...editing.patch, name: event.target.value } })
              }
              placeholder="Claude Code"
            />
          </Field>
          <Field label="Command">
            <Input className="font-mono text-xs"
              value={editing.patch.command ?? ""}
              onChange={(event) =>
                setEditing({ ...editing, patch: { ...editing.patch, command: event.target.value } })
              }
              placeholder="claude {prompt}"
            />
          </Field>
          <Field label="Model">
            <Combobox
              value={editing.patch.model ?? ""}
              onChange={(model) => setEditing({ ...editing, patch: { ...editing.patch, model } })}
              options={[
                { value: "", label: "The CLI's own default" },
                ...modelsFor(editing.patch.command ?? "").map((model) => ({
                  value: model.id,
                  label: model.id,
                  hint: model.label,
                })),
              ]}
              searchPlaceholder="Find or type a model…"
              allowCustom
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" type="submit" variant="default" disabled={!editing.patch.name?.trim()}>
              Save
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
