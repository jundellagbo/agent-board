"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import {
  CircleStopIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MapIcon,
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
import { Checkbox } from "./ui";
import { Badge } from "./ui/badge";
import { parseChecklist, progress } from "@/lib/checklist";
import type { RunState, Task, TmpFile } from "@/lib/types";

export type CardAction =
  | "interrupt"
  | "continue"
  | "block"
  | "drop"
  | "remote"
  | "plan"
  | "remove"
  | "edit"
  | "open"
  | "files";

const LIVE: RunState[] = ["queued", "planning", "running", "needs_approval"];

const ACTIONS: { id: CardAction; label: string; icon: typeof PlayIcon; danger?: boolean }[] = [
  { id: "interrupt", label: "Interrupt — stop what it is doing", icon: CircleStopIcon },
  { id: "continue", label: "Continue — tell it to carry on", icon: PlayIcon },
  { id: "block", label: "Block — hand it back to a person", icon: TriangleAlertIcon },
  { id: "drop", label: "Drop — abandon this run", icon: TrashIcon, danger: true },
];

function Controls({ task, onAction }: { task: Task; onAction: (action: CardAction) => void }) {
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

      <button
        type="button"
        title="Show this card's plan"
        aria-label="Show plan"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onAction("plan");
        }}
        className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
      >
        <MapIcon className="size-3.5" />
      </button>

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

function Checklist({ task, onToggle }: { task: Task; onToggle?: (index: number) => void }) {
  const steps = parseChecklist(task.body);
  if (steps.length === 0) return null;

  const { done, total } = progress(steps);
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
      </div>

      <ul className="space-y-0.5">
        {steps.map((step, index) => (
          <li key={`${index}-${step.text}`} className="flex items-start gap-1.5 text-xs">
            <Checkbox
              checked={step.done}
              disabled={!onToggle}
              aria-label={step.text}
              className="mt-0.5 size-3.5"
              // The card is draggable and opens on click; a checkbox inside it
              // has to keep both from firing.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={() => onToggle?.(index)}
            />
            <span
              className={`min-w-0 wrap-anywhere ${step.done ? "text-muted-foreground line-through" : ""}`}
            >
              {step.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * That the agent is working, without spelling out what it is doing.
 *
 * Its status line changes every second or two and is as long as it likes, so
 * showing it as text moved every card underneath it all run long. The rail is
 * always drawn, whether or not anything is happening inside it, so the card is
 * exactly as tall when the agent starts as when it stops.
 */
function Activity({ task, status }: { task: Task; status?: string }) {
  return (
    <div className="mt-1.5 h-1">
      {LIVE.includes(task.runState) && (
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <span className="activity-bar block h-full w-1/3 rounded-full bg-primary" />
              </div>
            }
          />
          <TooltipContent>{status ?? "Working…"}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function TaskCardBody({
  task,
  dragging,
  onToggleStep,
  onAction,
  status,
  files = [],
  onOpenFile,
  onRemoveFile,
}: {
  task: Task;
  dragging?: boolean;
  onToggleStep?: (index: number) => void;
  onAction?: (action: CardAction) => void;
  status?: string;
  /** What this card was given and what its agent handed back. */
  files?: TmpFile[];
  onOpenFile?: (file: TmpFile) => void;
  onRemoveFile?: (file: TmpFile) => void;
}) {
  const steps = parseChecklist(task.body);

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
      {task.body && steps.length === 0 && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground wrap-anywhere">{task.body}</p>
      )}
      <Activity task={task} status={status} />
      <Checklist task={task} onToggle={onToggleStep} />
      {onOpenFile && <AttachmentStrip files={files} onOpen={onOpenFile} onRemove={onRemoveFile} />}
      {onAction && <Controls task={task} onAction={onAction} />}
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
  onToggleStep,
  onAction,
  status,
  files,
  onOpenFile,
  onRemoveFile,
  editor,
}: {
  task: Task;
  onOpen: (task: Task) => void;
  onToggleStep: (task: Task, index: number) => void;
  onAction: (task: Task, action: CardAction) => void;
  status?: string;
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
                onToggleStep={(index) => onToggleStep(task, index)}
                onAction={(action) => onAction(task, action)}
                status={status}
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
              Open temp files
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
