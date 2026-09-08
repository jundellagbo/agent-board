import type { BoardGroup, RunState, Task } from "./types";

export interface Column {
  group: BoardGroup;
  tasks: Task[];
}

// How many cards a column will run at once. A WIP limit on the running lane is
// the natural place to say it; without one, one at a time is the safe default.
function capacity(group: BoardGroup, columns: Column[]): number {
  const running = columns.find((column) => column.group.id === group.runningGroupId)?.group;
  return running?.wipLimit ?? group.wipLimit ?? 1;
}

// Anything short of finished still occupies the lane: a card being prepared or
// waiting on a human is not capacity the next card can use.
const ACTIVE: RunState[] = ["queued", "planning", "running", "needs_approval"];

function activeCount(columns: Column[]): number {
  return columns
    .flatMap((column) => column.tasks)
    .filter((task) => ACTIVE.includes(task.runState)).length;
}

// Picks the next card an auto-run column is willing to start, or nothing when
// every lane is at capacity — the caller retries on the next board change.
// `hasSession` keeps a card that already has a terminal open from being claimed
// again, and keeps this decision free of any terminal or IPC dependency.
export function nextClaim(
  columns: Column[],
  hasSession: (taskId: string) => boolean = () => false,
  projectAutoRun = true,
): { task: Task; group: BoardGroup } | null {
  if (!projectAutoRun) return null;

  for (const { group, tasks } of columns) {
    if (!group.autoRun) continue;
    if (activeCount(columns) >= capacity(group, columns)) continue;

    const task = tasks.find(
      (candidate) => candidate.runState === "idle" && !hasSession(candidate.id),
    );
    if (task) return { task, group };
  }
  return null;
}
