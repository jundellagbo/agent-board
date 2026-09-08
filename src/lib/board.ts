"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { board as boardApi, groups as groupApi, tasks as taskApi } from "./ipc";
import type { BoardGroup, GroupPatch, Task, TaskPatch } from "./types";

export interface Column {
  group: BoardGroup;
  tasks: Task[];
}

export function useBoard(projectId: string | null) {
  const [groups, setGroups] = useState<BoardGroup[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setGroups([]);
      setTasks([]);
      setLoading(false);
      return;
    }
    try {
      const [nextGroups, nextTasks] = await Promise.all([
        groupApi.list(projectId),
        taskApi.list(projectId),
      ]);
      setGroups(nextGroups);
      setTasks(nextTasks);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Anything that moves a card says so, from wherever it happened — the runner,
  // another window, a card finishing long after the click that started it.
  useEffect(() => {
    if (!projectId) return;
    const unlisten = boardApi.onChanged((changed) => {
      if (changed === projectId) void refresh();
    });
    return () => void unlisten.then((stop) => stop());
  }, [projectId, refresh]);

  const columns = useMemo<Column[]>(
    () =>
      groups.map((group) => ({
        group,
        tasks: tasks
          .filter((task) => task.groupId === group.id)
          .sort((a, b) => a.position - b.position),
      })),
    [groups, tasks],
  );

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  // Paint the move immediately, then persist. A drag that fails still reverts,
  // because `run` always refreshes from the database afterwards.
  const moveTask = useCallback(
    (taskId: string, groupId: string, position: number) => {
      setTasks((current) => {
        const moving = current.find((task) => task.id === taskId);
        if (!moving) return current;
        const rest = current.filter((task) => task.id !== taskId);
        const target = rest
          .filter((task) => task.groupId === groupId)
          .sort((a, b) => a.position - b.position);
        target.splice(Math.max(0, Math.min(position, target.length)), 0, { ...moving, groupId });

        const repositioned = new Map(target.map((task, index) => [task.id, index]));
        return [
          ...rest.filter((task) => task.groupId !== groupId),
          ...target.map((task) => ({ ...task, position: repositioned.get(task.id)! })),
        ];
      });
      void run(() => taskApi.move(taskId, groupId, position));
    },
    [run],
  );

  return {
    columns,
    groups,
    loading,
    error,
    refresh,
    moveTask,
    addGroup: (patch: GroupPatch) =>
      projectId ? run(() => groupApi.create(projectId, patch)) : Promise.resolve(),
    updateGroup: (id: string, patch: GroupPatch) => run(() => groupApi.update(id, patch)),
    // Paint the new order first: a column snapping back while the write lands
    // reads as the drag having failed.
    reorderGroups: (ids: string[]) => {
      setGroups((current) => {
        const byId = new Map(current.map((group) => [group.id, group]));
        return ids.flatMap((id, position) => {
          const group = byId.get(id);
          return group ? [{ ...group, position }] : [];
        });
      });
      return run(() => groupApi.reorder(ids));
    },
    removeGroup: (id: string, moveTasksTo?: string) =>
      run(() => groupApi.remove(id, moveTasksTo)),
    addTask: (patch: TaskPatch, groupId: string) =>
      projectId ? run(() => taskApi.create(projectId, patch, groupId)) : Promise.resolve(),
    updateTask: (id: string, patch: TaskPatch) => run(() => taskApi.update(id, patch)),
    removeTask: (id: string) => run(() => taskApi.remove(id)),
  };
}
