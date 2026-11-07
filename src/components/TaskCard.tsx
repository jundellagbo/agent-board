"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import {
  CircleStopIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PaperclipIcon,
  PencilIcon,
  PlayIcon,
  RadioTowerIcon,
  TrashIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { AttachmentStrip } from "./Attachments";
import { StatusBadge } from "./StatusBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Badge } from "./ui/badge";
import type { RunState, Task, TmpFile } from "@/lib/types";

export type CardAction =
  "interrupt" | "continue" | "block" | "drop" | "remote" | "remove" | "edit" | "open" | "files";

const LIVE: RunState[] = ["queued", "planning", "running", "needs_approval"];

const ACTIONS: { id: CardAction; label: string; icon: typeof PlayIcon; danger?: boolean }[] = [
  { id: "interrupt", label: "Interrupt — stop what it is doing", icon: CircleStopIcon },
  { id: "continue", label: "Continue — tell it to carry on", icon: PlayIcon },
  { id: "block", label: "Block — hand it back to a person", icon: TriangleAlertIcon },
  { id: "drop", label: "Drop — abandon this run", icon: TrashIcon, danger: true },
];

function Controls({
  task,
  fileCount,
  onAction,
}: {
  task: Task;
  fileCount: number;
  onAction: (action: CardAction) => void;
}) {
  const live = LIVE.includes(task.runState);

  return (
    <div className="mt-1.5 flex items-center gap-0.5">
      <button
        type="button"
        title={
          task.remote
            ? "Remote control on — the agent can be driven from a phone"
            : "Remote control off"
        }
        aria-label="Remote control"
        aria-pressed={task.remote}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onAction("remote");
        }}
        className={`rounded p-1 transition-colors hover:bg-muted ${
          task.remote ? "text-primary" : "text-muted-foreground/50"
        }`}
      >
        <RadioTowerIcon className="size-3.5" />
      </button>

      {fileCount > 0 && (
        <button
          type="button"
          title="Show all of this card's files"
          aria-label={`Show all files (${fileCount})`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onAction("files");
          }}
          className="flex items-center gap-0.5 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
        >
          <PaperclipIcon className="size-3.5" />
          <span className="font-mono text-[0.6875rem] tabular-nums">{fileCount}</span>
        </button>
      )}

      {live &&
        ACTIONS.map(({ id, label, icon: Icon, danger }) => (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            // The card is draggable and opens on click; these must do neither.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onAction(id);
            }}
            className={`rounded p-1 text-muted-foreground transition-colors hover:bg-muted ${
              danger ? "hover:text-destructive" : "hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
    </div>
  );
}

/**
 * What the agent says it is doing right now, e.g. "Jitterbugging… (12s)".
 *
 * The row has a fixed height and truncates, so the status changing every second
 * never moves the cards underneath; it is only drawn while a run is live.
 */
function Activity({ task, status }: { task: Task; status?: string }) {
  if (!LIVE.includes(task.runState)) return null;
  const label = task.runState === "needs_approval" ? "Waiting for you" : (status ?? "Working…");
  return (
    <div className="mt-1.5 space-y-1">
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <span className="activity-bar block h-full w-1/3 rounded-full bg-primary" />
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <p className="h-4 truncate font-mono text-[0.6875rem] leading-4 text-primary">
              {label}
            </p>
          }
        />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The agent's last few lines, so a card says what is happening without a trip to its terminal. */
function MiniTerminal({ lines }: { lines?: string[] }) {
  if (!lines || lines.length === 0) return null;
  return (
    <pre
      aria-label="Latest terminal output"
      className="mt-1.5 overflow-hidden rounded-md border border-border bg-background px-2 py-1 font-mono text-[0.6875rem] leading-snug text-muted-foreground"
    >
      {lines.map((line, index) => (
        <span key={index} className="block truncate">
          {line}
        </span>
      ))}
    </pre>
  );
}

export function TaskCardBody({
  task,
  dragging,
  onAction,
  status,
  recent,
  files = [],
  onOpenFile,
  onRemoveFile,
}: {
  task: Task;
  dragging?: boolean;
  onAction?: (action: CardAction) => void;
  status?: string;
  recent?: string[];
  /** What this card was given and what its agent handed back. */
  files?: TmpFile[];
  onOpenFile?: (file: TmpFile) => void;
  onRemoveFile?: (file: TmpFile) => void;
}) {
  return (
    <article
      className={`relative rounded-lg border border-border bg-card px-2.5 py-2 text-left shadow-sm ${
        dragging ? "shadow-lg ring-1 ring-ring" : ""
      }`}
    >
      {/* Out of the flow, so a card does not grow a row the moment its agent
          starts. The title keeps the corner clear whatever state it is in — a
          reserved gap costs nothing next to the whole card jumping. */}
      <div className="absolute top-2 right-2">
        <StatusBadge state={task.runState} />
      </div>

      {/* A card's own text is the one thing on the board nobody has vetted: the
          attachment picker writes file paths straight into it, and a path is a
          single unbreakable word wider than any column. */}
      <p className="line-clamp-3 pr-24 text-[0.9375rem] leading-snug wrap-anywhere">{task.title}</p>
      {task.body && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground wrap-anywhere">{task.body}</p>
      )}
      <Activity task={task} status={status} />
      <MiniTerminal lines={recent} />
      {onOpenFile && <AttachmentStrip files={files} onOpen={onOpenFile} onRemove={onRemoveFile} />}
      {onAction && <Controls task={task} fileCount={files.length} onAction={onAction} />}
      {task.githubNumber !== null && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {task.githubKind === "pull" ? "PR" : "issue"} #{task.githubNumber}
        </p>
      )}
      {task.branch && (
        // Long branch names are the norm, so the badge truncates and keeps the
        // whole name in its tooltip rather than widening the card.
        <Badge
          variant="outline"
          title={task.branch}
          className="mt-1.5 max-w-full font-mono font-normal text-muted-foreground"
        >
          <GitBranchIcon />
          {/* Without min-w-0 a flex child will not shrink below its text, so the
              badge would grow instead of the name ellipsing. */}
          <span className="min-w-0 truncate">{task.branch}</span>
        </Badge>
      )}
    </article>
  );
}

export function TaskCard({
  task,
  onOpen,
  onAction,
  status,
  recent,
  files,
  onOpenFile,
  onRemoveFile,
  editor,
}: {
  task: Task;
  onOpen: (task: Task) => void;
  onAction: (task: Task, action: CardAction) => void;
  status?: string;
  recent?: string[];
  files?: TmpFile[];
  onOpenFile: (file: TmpFile) => void;
  onRemoveFile: (file: TmpFile) => void;
  /** Name of the editor a card can be opened in, when there is one. */
  editor?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { groupId: task.groupId },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
    >
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              {...attributes}
              {...listeners}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(task)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onOpen(task);
              }}
              className="cursor-grab active:cursor-grabbing"
            >
              <TaskCardBody
                task={task}
                onAction={(action) => onAction(task, action)}
                status={status}
                recent={recent}
                files={files}
                onOpenFile={onOpenFile}
                onRemoveFile={onRemoveFile}
              />
            </div>
          }
        />
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onAction(task, "edit")}>
            <PencilIcon />
            Edit card…
          </ContextMenuItem>
          <ContextMenuItem disabled={!editor} onClick={() => onAction(task, "open")}>
            <FolderOpenIcon />
            {editor ? `Open in ${editor}` : "No editor found"}
          </ContextMenuItem>
          {/* Only when there is something to open: the store is per card, and an
              empty one has no directory on disk yet. */}
          {files && files.length > 0 && (
            <ContextMenuItem onClick={() => onAction(task, "files")}>
              <PaperclipIcon />
              Show all files
            </ContextMenuItem>
          )}
          <ContextMenuItem variant="destructive" onClick={() => onAction(task, "remove")}>
            <TrashIcon />
            Remove card…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
