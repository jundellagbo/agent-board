import assert from "node:assert/strict";
import { test } from "node:test";

import { nextClaim } from "./claim.ts";
import type { BoardGroup, Task } from "./types";

function group(overrides: Partial<BoardGroup>): BoardGroup {
  return {
    id: "g",
    projectId: "p",
    name: "Todo",
    boardType: "todo",
    position: 0,
    autoRun: false,
    plans: false,
    skills: [],
    command: null,
    prompt: null,
    agentId: null,
    model: null,
    runningGroupId: null,
    successGroupId: null,
    failureGroupId: null,
    wipLimit: null,
    color: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "t",
    projectId: "p",
    groupId: "g",
    title: "work",
    body: null,
    plan: null,
    position: 0,
    agentId: null,
    model: null,
    remote: true,
    githubUrl: null,
    githubKind: null,
    githubNumber: null,
    branch: null,
    worktreePath: null,
    runState: "idle",
    lastRunId: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const todo = group({ id: "todo", autoRun: true, runningGroupId: "wip" });
const wip = group({ id: "wip", name: "In Progress", boardType: "in_progress" });

test("claims the first idle card in an auto-run column", () => {
  const claim = nextClaim([
    { group: todo, tasks: [task({ id: "a" }), task({ id: "b" })] },
    { group: wip, tasks: [] },
  ]);
  assert.equal(claim?.task.id, "a");
});

test("leaves columns that are not auto-run alone", () => {
  const claim = nextClaim([{ group: group({ id: "manual" }), tasks: [task({ id: "a" })] }]);
  assert.equal(claim, null);
});

test("one card at a time unless the running lane says otherwise", () => {
  const busy = [
    { group: todo, tasks: [task({ id: "a" })] },
    { group: wip, tasks: [task({ id: "r", groupId: "wip", runState: "running" as const })] },
  ];
  assert.equal(nextClaim(busy), null, "the default capacity is one");

  const wider = [
    busy[0],
    { group: { ...wip, wipLimit: 2 }, tasks: busy[1].tasks },
  ];
  assert.equal(nextClaim(wider)?.task.id, "a", "a WIP limit of 2 lets a second start");
});

test("a card being prepared already occupies the lane", () => {
  const claim = nextClaim([
    { group: todo, tasks: [task({ id: "a" })] },
    { group: wip, tasks: [task({ id: "q", groupId: "wip", runState: "queued" as const })] },
  ]);
  assert.equal(claim, null, "queued counts against capacity, not just running");
});

test("a card waiting on a human holds its slot", () => {
  const claim = nextClaim([
    { group: todo, tasks: [task({ id: "a" })] },
    {
      group: wip,
      tasks: [task({ id: "w", groupId: "wip", runState: "needs_approval" as const })],
    },
  ]);
  assert.equal(claim, null);
});

test("a project with auto-mode off claims nothing", () => {
  const board = [
    { group: todo, tasks: [task({ id: "a" })] },
    { group: wip, tasks: [] },
  ];

  assert.equal(nextClaim(board, () => false, true)?.task.id, "a");
  assert.equal(nextClaim(board, () => false, false), null, "the project switch wins");
});

test("planning holds the lane, but a blocked card releases it", () => {
  const withState = (runState: "planning" | "blocked") => [
    { group: todo, tasks: [task({ id: "a" })] },
    { group: wip, tasks: [task({ id: "b", groupId: "wip", runState })] },
  ];

  assert.equal(nextClaim(withState("planning")), null, "planning is still working");
  assert.equal(
    nextClaim(withState("blocked"))?.task.id,
    "a",
    "a card waiting on a person is not occupying the runner",
  );
});
