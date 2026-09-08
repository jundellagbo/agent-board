"use client";

import { AgentSettings } from "./AgentSettings";
import { Combobox } from "./Combobox";
import { IndexPanel } from "./IndexPanel";
import { McpSettings } from "./McpSettings";
import { NotificationSettings } from "./NotificationSettings";
import { PluginSettings } from "./PluginSettings";
import { ThemeSettings } from "./ThemeSettings";
import { CheckField, Field } from "./ui";
import { projects as projectApi } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import type { Agent, Project } from "@/lib/types";

function ProjectAgent({ project, agents }: { project: Project; agents: Agent[] }) {
  const { run } = useStore();

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{project.name}</h2>
      <p className="text-xs text-muted-foreground">
        Adding a project records it — and the worktrees made inside it — as trusted for the agent
        CLI, so an unattended run is not stopped by its “do you trust this folder” prompt.
      </p>

      <CheckField
        label="Run cards automatically"
        checked={project.autoRun}
        hint="columns still choose whether they claim cards"
        onChange={(autoRun) => void run(() => projectApi.update(project.id, { autoRun }))}
      />

      <CheckField
        label="Give each card its own git worktree"
        checked={project.useWorktrees}
        disabled={!project.isGit}
        hint={project.isGit ? undefined : "(not a git repository)"}
        onChange={(useWorktrees) => void run(() => projectApi.update(project.id, { useWorktrees }))}
      />

      <Field label="Default agent for this project">
        <Combobox
          className="max-w-sm"
          value={project.agentId ?? ""}
          onChange={(agentId) =>
            void run(() => projectApi.update(project.id, { agentId: agentId || null }))
          }
          options={[
            { value: "", label: "Use the global default" },
            ...agents.map((agent) => ({ value: agent.id, label: agent.name, hint: agent.command })),
          ]}
          searchPlaceholder="Find an agent…"
        />
      </Field>
    </section>
  );
}

export function SettingsPane() {
  const { project, agents } = useStore();

  return (
    <div className="scroll-pane mx-auto h-full max-w-3xl space-y-8 overflow-y-auto pb-8">
      {project && <ProjectAgent project={project} agents={agents} />}
      {project && <IndexPanel project={project} />}
      <AgentSettings />
      <McpSettings />
      <PluginSettings />
      <NotificationSettings />
      <ThemeSettings />
    </div>
  );
}
