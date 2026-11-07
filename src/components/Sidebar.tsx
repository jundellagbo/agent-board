"use client";

import { GitBranchIcon, PaperclipIcon, PencilIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
import {
  orgs as orgApi,
  projects as projectApi,
  tmp as tmpApi,
  worktrees as worktreeApi,
  type Worktree,
} from "@/lib/ipc";
import { useStore } from "@/lib/store";
import type { Project } from "@/lib/types";

type Dialog = { kind: "new-org" } | { kind: "rename-org" } | { kind: "new-project" } | null;

export function Sidebar() {
  const { orgs, projects, org, project, branch, selectOrg, selectProject, run } = useStore();
  const [dialog, setDialog] = useState<Dialog>(null);
  // Deleting an org is destructive and irreversible, so the row itself asks
  // before it happens rather than a modal the user can dismiss by reflex.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [checkouts, setCheckouts] = useState<Record<string, Worktree[]>>({});
  const [droppingTree, setDroppingTree] = useState<{ project: Project; tree: Worktree } | null>(
    null,
  );

  const loadCheckouts = useCallback(async () => {
    const entries = await Promise.all(
      projects.map(
        async (item) => [item.id, await worktreeApi.list(item.id).catch(() => [])] as const,
      ),
    );
    setCheckouts(Object.fromEntries(entries));
  }, [projects]);

  // Cards add worktrees while they run, so the list is re-read rather than
  // trusted from the first load.
  useEffect(() => {
    void loadCheckouts();
    const timer = window.setInterval(() => void loadCheckouts(), 10_000);
    return () => window.clearInterval(timer);
  }, [loadCheckouts]);

  async function removeTree(target: { project: Project; tree: Worktree }) {
    setDroppingTree(null);
    await run(() => worktreeApi.removeByPath(target.project.id, target.tree.path));
    await loadCheckouts();
  }

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
              const trees = checkouts[item.id] ?? [];
              const own = trees.find((tree) => tree.main);
              const others = trees.filter((tree) => !tree.main);
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
                          {own?.branch && (
                            <span
                              className={`mt-0.5 flex items-center gap-1 truncate font-mono text-xs ${
                                active ? "opacity-80" : "text-muted-foreground"
                              }`}
                              title={own.branch}
                            >
                              <GitBranchIcon className="size-3 shrink-0" />
                              <span className="truncate">{own.branch}</span>
                            </span>
                          )}
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
                  {others.length > 0 && (
                    <ul className="mt-0.5 ml-3 space-y-px border-l border-border pl-2">
                      {others.map((tree) => {
                        const picked = active && tree.branch !== null && tree.branch === branch;
                        return (
                          <li
                            key={tree.path}
                            className={`group flex items-center gap-1 rounded transition-colors ${
                              picked ? "bg-muted" : "hover:bg-muted"
                            }`}
                          >
                            <button
                              type="button"
                              disabled={!tree.branch}
                              title={
                                tree.branch
                                  ? `Show and add cards on ${tree.branch}\n${tree.path}`
                                  : tree.path
                              }
                              aria-current={picked ? "true" : undefined}
                              onClick={() => selectProject(item.id, tree.branch)}
                              className={`flex min-w-0 flex-1 items-center gap-1 px-1 py-0.5 text-left font-mono text-xs ${
                                picked ? "text-foreground" : "text-muted-foreground"
                              } disabled:cursor-default`}
                            >
                              <GitBranchIcon className="size-3 shrink-0" />
                              <span className="min-w-0 truncate">{tree.branch ?? "detached"}</span>
                            </button>
                            <button
                              type="button"
                              aria-label={`Remove worktree ${tree.branch ?? tree.path}`}
                              title="Remove worktree"
                              onClick={() => setDroppingTree({ project: item, tree })}
                              className="mr-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                            >
                              <XIcon className="size-3" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
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

      {droppingTree && (
        <Modal title="Remove worktree?" onClose={() => setDroppingTree(null)}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-mono">{droppingTree.tree.path}</span> is deleted with any
              uncommitted changes in it.
              {droppingTree.tree.branch && (
                <>
                  {" "}
                  The branch <span className="font-mono">{droppingTree.tree.branch}</span> is kept.
                </>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setDroppingTree(null)}>
                Keep it
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void removeTree(droppingTree)}>
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
