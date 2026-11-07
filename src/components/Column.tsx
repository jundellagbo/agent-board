"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EllipsisIcon, GripVerticalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AttachmentPicker } from "./Attachments";
import { Combobox } from "./Combobox";
import { CommandInput } from "./CommandInput";
import { reserveCardId } from "@/lib/attachments";
import { appendPath } from "@/lib/compose";
import { commandName, commandQuery } from "@/lib/compose";
import { clearDraft, readDraft, writeDraft } from "@/lib/drafts";
import { slash as slashApi, tmp as tmpApi, worktrees as worktreeApi } from "@/lib/ipc";
import { modelsFor } from "@/lib/models";

import { cardFromInput, looksLikeGithub } from "@/lib/github";

import { TaskCard, type CardAction } from "./TaskCard";
import { Button, CheckField, Input } from "./ui";
import { pickAgent } from "@/lib/agent";
import type { Column as ColumnData } from "@/lib/board";
import { useStore } from "@/lib/store";
import type { SlashCommand, Task, TaskPatch, TmpFile } from "@/lib/types";

/** Columns and their card-drop areas share a board but not an identity. */
export function columnDragId(groupId: string): string {
  return `column:${groupId}`;
}

export function groupIdFromDrag(dragId: string): string | null {
  return dragId.startsWith("column:") ? dragId.slice("column:".length) : null;
}

export function Column({
  column,
  onAdd,
  onOpen,
  onEdit,
  onAction,
  statuses,
  recents,
  files,
  onOpenFile,
  onRemoveFile,
  editor,
}: {
  column: ColumnData;
  onAdd: (patch: TaskPatch, groupId: string, id?: string) => void;
  onOpen: (task: Task, group: ColumnData["group"]) => void;
  onEdit: (group: ColumnData["group"]) => void;
  onAction: (task: Task, action: CardAction) => void;
  statuses: Record<string, string>;
  recents: Record<string, string[]>;
  /** Every card's tmp files, keyed by card — read once for the whole board. */
  files: Record<string, TmpFile[]>;
  onOpenFile: (file: TmpFile) => void;
  onRemoveFile: (file: TmpFile) => void;
  editor?: string;
}) {
  const { group, tasks } = column;
  const composer = useRef<HTMLFormElement>(null);
  const { agents, project, branch: scope } = useStore();
  // What this column would run if the card said nothing — shown as the default
  // so the choice is visible before it matters.
  const defaultAgent = pickAgent(agents, {
    group,
    project: project ?? undefined,
  });
  const { setNodeRef, isOver } = useDroppable({
    id: group.id,
    data: { groupId: group.id },
  });
  // A separate id from the droppable above: one is where cards land, the other
  // is the column itself being moved.
  const sortable = useSortable({ id: columnDragId(group.id), data: { type: "column" } });
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  // The card's id, chosen before the card exists so anything attached while
  // composing is already filed under it — and so the path written into the
  // card's own text stays right once the card is real.
  const [draftId, setDraftId] = useState(reserveCardId);
  const [attached, setAttached] = useState(false);

  const overLimit = group.wipLimit !== null && tasks.length > group.wipLimit;

  const [resolving, setResolving] = useState(false);
  // Empty means "whatever this column would pick anyway", so the card is not
  // pinned to today's default the moment it is created.
  const [agentId, setAgentId] = useState("");
  const [model, setModel] = useState("");
  // Empty means a new branch, named after the card once it runs. A card only
  // needs a branch of its own when the project is a repo, so the choice is only
  // offered when there is something to choose between.
  // A board narrowed to one worktree adds its cards on that worktree's branch.
  const [branch, setBranch] = useState(scope ?? "");
  const [newBranch, setNewBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  // Two agents editing one working tree overwrite each other, so a card gets its
  // own checkout unless someone says otherwise.
  const [useWorktree, setUseWorktree] = useState(true);

  useEffect(() => {
    if (!composing) setBranch(scope ?? "");
  }, [scope, composing]);

  useEffect(() => {
    if (!composing) return;
    void worktreeApi
      .branches(group.projectId)
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [composing, group.projectId]);

  // Read after mounting rather than during render: this page is prerendered,
  // where there is no storage to read and a different first paint would be a
  // hydration mismatch.
  useEffect(() => {
    const draft = readDraft(group.id);
    if (!draft) return;
    setTitle(draft.title);
    setAgentId(draft.agentId);
    setModel(draft.model);
    setBranch(draft.branch);
    setNewBranch(draft.newBranch);
    setUseWorktree(draft.useWorktree);
    setComposing(true);
  }, [group.id]);

  // Kept as it is typed, so switching project or view does not discard it.
  useEffect(() => {
    if (composing) writeDraft(group.id, { title, agentId, model, branch, newBranch, useWorktree });
  }, [composing, group.id, title, agentId, model, branch, newBranch, useWorktree]);
  // A command belongs to the piece of work, not to the column it starts in.
  const [commands, setCommands] = useState<SlashCommand[]>([]);

  // Re-read every time a command is started, not once: commands, skills and
  // plugins change on disk while the app is open, and the agent will see them.
  const startsCommand = title.startsWith("/");
  useEffect(() => {
    if (!composing) return;
    void slashApi
      .list(group.projectId)
      .then(setCommands)
      .catch(() => setCommands([]));
  }, [composing, group.projectId, startsCommand]);

  const chosenAgent = agents.find((agent) => agent.id === agentId) ?? defaultAgent;
  // Typing the command is the way to use one, so the composer says whether the
  // one you typed is real rather than offering a second way to pick it.
  const typed = commandName(title);
  const known = typed ? commands.find((command) => command.name === typed) : undefined;

  function reset({ keepFiles = false } = {}) {
    setTitle("");
    setAgentId("");
    setModel("");
    setBranch(scope ?? "");
    setNewBranch("");
    setUseWorktree(true);
    setComposing(false);
    // Abandoning the card abandons what was attached to it: those files are
    // filed under an id no card will ever have.
    if (attached && !keepFiles) void tmpApi.clear(draftId).catch(() => undefined);
    setAttached(false);
    setDraftId(reserveCardId());
    // Cancelling is a decision to discard; navigating away is not.
    clearDraft(group.id);
  }

  async function submit() {
    if (title.trim() === "" || resolving) return;
    setResolving(true);
    const patch = await cardFromInput(title);
    setResolving(false);
    // A card that names no branch gets one generated from its title when it
    // first runs, which is also when we know the name is still free.
    onAdd(
      {
        ...patch,
        agentId: agentId || null,
        model: model || null,
        branch: branch || newBranch.trim() || patch.branch || null,
        useWorktree,
      },
      group.id,
      draftId,
    );
    reset({ keepFiles: true });
  }

  return (
    <section
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`group/column flex w-72 shrink-0 flex-col rounded-[calc(var(--radius)*1.5)] border border-border bg-muted/60 ${
        sortable.isDragging ? "opacity-60 ring-1 ring-ring" : ""
      }`}
    >
      <header className="flex items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          aria-label={`Move ${group.name}`}
          title="Drag to reorder"
          {...sortable.attributes}
          {...sortable.listeners}
          className="-ml-1.5 cursor-grab text-muted-foreground opacity-0 transition group-hover/column:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: group.color ?? "var(--border-strong)" }}
        />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide uppercase">
          {group.name}
        </h2>
        <span
          className={`shrink-0 font-mono text-sm tabular-nums ${
            overLimit ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {group.wipLimit !== null ? `${tasks.length}/${group.wipLimit}` : tasks.length}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Edit column"
          onClick={() => onEdit(group)}
          className="shrink-0 text-muted-foreground opacity-0 transition group-hover/column:opacity-100 focus-visible:opacity-100"
        >
          <EllipsisIcon />
        </Button>
        {group.autoRun && (
          <span
            title="The runner claims cards from this column"
            className="shrink-0 rounded bg-primary/15 px-1 text-xs font-medium text-primary"
          >
            auto
          </span>
        )}
      </header>

      <div
        ref={setNodeRef}
        className={`scroll-pane min-h-0 flex-1 overflow-y-auto pb-2 transition-colors ${
          isOver ? "bg-primary/5" : ""
        }`}
      >
        <SortableContext
          items={tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="space-y-1.5">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onOpen={(picked) => onOpen(picked, group)}
                onAction={onAction}
                status={statuses[task.id]}
                recent={recents[task.id]}
                files={files[task.id]}
                onOpenFile={onOpenFile}
                onRemoveFile={onRemoveFile}
                editor={editor}
              />
            ))}
          </ul>
        </SortableContext>

        {tasks.length === 0 && !composing && (
          <p className="px-1 py-3 text-xs text-muted-foreground">Nothing here.</p>
        )}
      </div>

      <footer className="px-1.5 pb-1.5">
        {composing ? (
          <form
            ref={composer}
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <CommandInput
              autoFocus
              value={title}
              onValueChange={setTitle}
              commands={commands}
              onBlur={(event) => {
                // Blur into the pickers below is not a cancel.
                if (
                  event.relatedTarget instanceof Node &&
                  composer.current?.contains(event.relatedTarget)
                )
                  return;
                if (title.trim() === "" && !attached) reset();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
                if (event.key === "Escape") reset();
              }}
              rows={3}
              placeholder="What should the agent do? Type / for commands"
              className="resize-none bg-card"
            />
            {looksLikeGithub(title) && (
              <p className="px-1 text-xs text-muted-foreground">
                {resolving ? "Reading GitHub…" : "Enter fetches the title and branch"}
              </p>
            )}

            {typed && (known || commandQuery(title) === null) && (
              <p
                className={`px-1 text-xs ${known ? "text-muted-foreground" : "text-warning"}`}
                role={known ? undefined : "alert"}
              >
                {known
                  ? (known.description ?? `${known.scope} command`)
                  : `${typed} is not a command on this machine`}
              </p>
            )}

            {/* The path lands in the card's text as the file does: the agent
                reads the card, not the directory. */}
            <AttachmentPicker
              compact
              cardId={draftId}
              onAttached={(file) => {
                setAttached(true);
                setTitle((current) => appendPath(current, file.path));
              }}
            />

            <div className="grid grid-cols-2 gap-1.5">
              <Combobox
                value={agentId}
                onChange={setAgentId}
                options={[
                  {
                    value: "",
                    label: defaultAgent ? `${defaultAgent.name} (default)` : "Default agent",
                  },
                  ...agents.map((agent) => ({
                    value: agent.id,
                    label: agent.name,
                  })),
                ]}
                searchPlaceholder="Find an agent…"
                className="h-7 text-xs"
              />
              <Combobox
                value={model}
                onChange={setModel}
                allowCustom
                options={[
                  {
                    value: "",
                    label: chosenAgent?.model ? `${chosenAgent.model} (default)` : "Agent's model",
                  },
                  ...modelsFor(chosenAgent?.command ?? "").map((option) => ({
                    value: option.id,
                    label: option.id,
                    hint: option.label,
                  })),
                ]}
                searchPlaceholder="Find or type a model…"
                className="h-7 text-xs"
              />
            </div>

            {branches.length > 0 && (
              <div className="space-y-1.5">
                <CheckField
                  compact
                  label="Own worktree"
                  checked={useWorktree}
                  hint="its own checkout"
                  onChange={setUseWorktree}
                />
                <Combobox
                  value={branch}
                  onChange={setBranch}
                  options={[
                    { value: "", label: "New branch", hint: "named after the card" },
                    ...branches.map((name) => ({ value: name, label: name })),
                  ]}
                  searchPlaceholder="Find a branch…"
                  className="h-7 text-xs"
                />
                {branch === "" && (
                  <Input
                    value={newBranch}
                    onChange={(event) => setNewBranch(event.target.value)}
                    placeholder="Branch name — leave empty to name it after the card"
                    className="h-7 font-mono text-xs"
                  />
                )}
              </div>
            )}

            <div className="flex justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={() => reset()}>
                Cancel
              </Button>
              <Button size="xs" type="submit" disabled={title.trim() === "" || resolving}>
                Add card
              </Button>
            </div>
          </form>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="w-full text-muted-foreground"
            onClick={() => setComposing(true)}
          >
            + Add card
          </Button>
        )}
      </footer>
    </section>
  );
}
