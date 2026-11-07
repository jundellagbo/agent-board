"use client";

import { PaperclipIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

import { Combobox } from "./Combobox";
import { OrgDialog } from "./OrgDialog";
import { ProjectDialog } from "./ProjectDialog";
import { Button, Modal } from "./ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { orgs as orgApi, projects as projectApi, tmp as tmpApi } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import type { Project } from "@/lib/types";

type Dialog = { kind: "new-org" } | { kind: "rename-org" } | { kind: "new-project" } | null;

export function Sidebar() {
  const { orgs, projects, org, project, selectOrg, selectProject, run } = useStore();
  const [dialog, setDialog] = useState<Dialog>(null);
  // Deleting an org is destructive and irreversible, so the row itself asks
  // before it happens rather than a modal the user can dismiss by reflex.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);

  async function removeProject(target: Project) {
    setRemoving(null);
    if (target.id === project?.id) selectProject(null);
    await run(() => projectApi.remove(target.id));
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="space-y-2 border-b border-border px-3 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Organization
          </span>
          <div className="flex gap-1">
            {org && (
              <Button
                size="xs"
                variant="ghost"
                title="Rename organization"
                onClick={() => setDialog({ kind: "rename-org" })}
              >
                <PencilIcon />
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              title="New organization"
              onClick={() => setDialog({ kind: "new-org" })}
            >
              <PlusIcon />
            </Button>
          </div>
        </div>

        <Combobox
          value={org?.id ?? ""}
          onChange={(id) => selectOrg(id || null)}
          options={orgs.map((item) => ({ value: item.id, label: item.name }))}
          placeholder={orgs.length === 0 ? "No organizations" : "Choose an organization"}
          searchPlaceholder="Find an organization…"
        />

        {org && (
          <Button
            size="xs"
            variant={confirming === org.id ? "destructive" : "ghost"}
            className={`w-full justify-start ${
              confirming === org.id ? "" : "text-muted-foreground hover:text-destructive"
            }`}
            onClick={() => {
              if (confirming === org.id) {
                setConfirming(null);
                void run(() => orgApi.remove(org.id));
              } else {
                setConfirming(org.id);
              }
            }}
          >
            {confirming === org.id ? "Delete org and all its projects?" : "Delete organization"}
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Projects
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Add project"
          disabled={!org}
          onClick={() => setDialog({ kind: "new-project" })}
        >
          <PlusIcon />
        </Button>
      </div>

      <nav className="scroll-pane min-h-0 flex-1 overflow-y-auto pb-2">
        {projects.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {org ? "No projects yet." : "Create an organization to begin."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {projects.map((item) => {
              const active = item.id === project?.id;
              return (
                <li key={item.id}>
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => selectProject(item.id)}
                          aria-current={active ? "true" : undefined}
                          className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                            active ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                          }`}
                        >
                          <span className="block truncate text-sm">{item.name}</span>
                          <span
                            className={`block truncate font-mono text-xs ${
                              active ? "opacity-80" : "text-muted-foreground"
                            }`}
                          >
                            {item.path}
                          </span>
                        </button>
                      }
                    />
                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={() => void run(() => tmpApi.revealProject(item.id))}
                      >
                        <PaperclipIcon />
                        Show temp files
                      </ContextMenuItem>
                      <ContextMenuItem variant="destructive" onClick={() => setRemoving(item)}>
                        <TrashIcon />
                        Remove project…
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {removing && (
        <Modal title={`Remove “${removing.name}”?`} onClose={() => setRemoving(null)}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Its cards, columns and run history go with it, along with the scratch files they
              collected. The project directory itself is left alone.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setRemoving(null)}>
                Keep it
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void removeProject(removing)}>
                Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {dialog?.kind === "new-org" && <OrgDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "rename-org" && org && (
        <OrgDialog org={org} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "new-project" && org && (
        <ProjectDialog orgId={org.id} onClose={() => setDialog(null)} />
      )}
    </aside>
  );
}
