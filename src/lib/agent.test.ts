import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  isCommandCard,
  pickAgent,
  pickModel,
  priorWork,
  resolveCommand,
  taskPrompt,
} from "./agent.ts";
import type { Agent, BoardGroup, Project, Task, TaskRun } from "./types";

const group = {
  id: "g1",
  projectId: "p1",
  name: "Testing",
  boardType: "custom",
  position: 0,
  autoRun: true,
  plans: false,
  skills: ["infra-llm-review", "security-review"],
  command: null,
  prompt: "Review the change.",
  agentId: null,
  model: null,
  runningGroupId: null,
  successGroupId: null,
  failureGroupId: null,
  wipLimit: null,
  color: null,
  createdAt: "",
  updatedAt: "",
} satisfies BoardGroup;

const task = {
  id: "t1",
  projectId: "p1",
  groupId: "g1",
  title: "Fix the flaky test",
  body: null,
  plan: null,
  position: 0,
  agentId: null,
  model: null,
  remote: true,
  useWorktree: true,
  githubUrl: null,
  githubKind: null,
  githubNumber: null,
  branch: null,
  worktreePath: null,
  runState: "idle",
  lastRunId: null,
  createdAt: "",
  updatedAt: "",
} satisfies Task;

test("the prompt is the column instruction followed by the card", () => {
  assert.equal(taskPrompt(task, group), "Review the change.\n\nFix the flaky test");
});

test("placeholders are filled and quoted", () => {
  const command = resolveCommand("claude -p {prompt} --skills {skills}", {
    task,
    group,
    path: "/tmp/app",
  });
  assert.equal(
    command,
    "claude -p 'Review the change.\n\nFix the flaky test' --skills 'infra-llm-review,security-review'",
  );
});

// Ask a real shell to split it: the Rust side uses POSIX word rules, so if the
// title survives as one argument here, it survives there too.
test("a card title cannot break out of its argument", () => {
  const hostile = { ...task, title: "'; rm -rf ~; echo pwned '" };
  const command = resolveCommand("printf %s {task}", { task: hostile, group, path: "/tmp" });
  const output = execFileSync("sh", ["-c", command], { encoding: "utf8" });

  assert.equal(output, hostile.title);
});

const agents = [
  { id: "a1", name: "Claude", command: "claude {prompt}", env: "{}", isDefault: true },
  { id: "a2", name: "Aider", command: "aider", env: "{}", isDefault: false },
  { id: "a3", name: "Codex", command: "codex", env: "{}", isDefault: false },
].map((agent) => ({ ...agent, model: null, createdAt: "", updatedAt: "" }));

test("the most specific agent wins", () => {
  const project = { id: "p1", agentId: "a2" } as Project;

  assert.equal(pickAgent(agents, {})?.id, "a1", "falls back to the default");
  assert.equal(pickAgent(agents, { project })?.id, "a2", "the project overrides the default");
  assert.equal(
    pickAgent(agents, { project, group: { ...group, agentId: "a3" } })?.id,
    "a3",
    "the column overrides the project",
  );
  assert.equal(
    pickAgent(agents, {
      project,
      group: { ...group, agentId: "a3" },
      task: { ...task, agentId: "a1" },
    })?.id,
    "a1",
    "the card overrides everything",
  );
});

const columnName = (id: string | null) => (id === "g-todo" ? "Todo" : "In Review");

function run(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: "r1",
    taskId: "t1",
    agentId: null,
    groupId: "g-todo",
    command: "claude 'fix it'",
    cwd: "/tmp",
    status: "exited",
    exitCode: 0,
    logPath: null,
    summary: null,
    startedAt: "2026-09-07T10:00:00Z",
    finishedAt: "2026-09-07T10:05:00Z",
    ...overrides,
  };
}

test("an agent is let into the card's scratch store, and only when there is one", () => {
  const template = "claude --add-dir {tmp} {prompt}";

  assert.match(
    resolveCommand(template, { task, group, path: "/tmp/app", tmp: "/store/t1" }),
    /--add-dir '\/store\/t1'/,
  );
  assert.equal(
    resolveCommand(template, { task, group, path: "/tmp/app" }).includes("--add-dir"),
    false,
    "a card with no files drops the flag rather than passing an empty path",
  );
});

test("a card with no history adds nothing to the prompt", () => {
  assert.equal(priorWork([], columnName), "");
  assert.equal(priorWork([run({ finishedAt: null })], columnName), "", "a live run is not history");
});

test("the next agent is told what the previous one did", () => {
  const history = priorWork([run({ summary: "Edited 3 files, tests pass." })], columnName);

  assert.match(history, /In "Todo" an agent ran `claude 'fix it'` and finished cleanly\./);
  assert.match(history, /Edited 3 files, tests pass\./);
});

test("a failure says so, and long output is trimmed from the front", () => {
  const history = priorWork([run({ exitCode: 2, summary: "x".repeat(900) })], columnName, {
    excerpt: 100,
  });

  assert.match(history, /stopped with exit code 2/);
  assert.ok(history.includes("…"), "the excerpt is marked as truncated");
  assert.ok(history.length < 400, `kept ${history.length} characters`);
});

test("history reads oldest first, and only the last few runs", () => {
  const history = priorWork(
    [
      run({ id: "r3", groupId: "g-review", summary: "third" }),
      run({ id: "r2", summary: "second" }),
      run({ id: "r1", summary: "first" }),
    ],
    columnName,
    { limit: 2 },
  );

  assert.ok(history.indexOf("second") < history.indexOf("third"), "oldest first");
  assert.ok(!history.includes("first"), "older runs beyond the limit are dropped");
});

test("the model fills its placeholder", () => {
  const command = resolveCommand("claude --model {model} {task}", {
    task,
    group,
    path: "/tmp",
    model: "claude-opus-5",
  });
  assert.equal(command, "claude --model 'claude-opus-5' 'Fix the flaky test'");
});

test("no model means no --model flag, not an empty one", () => {
  const command = resolveCommand("claude --model {model} {task}", {
    task,
    group,
    path: "/tmp",
  });
  assert.equal(command, "claude 'Fix the flaky test'");
  assert.ok(!command.includes("--model"), "an empty model would be read as a model named ''");
});

test("a card's own model beats the agent's", () => {
  const pinned = { ...task, model: "claude-haiku-4-5" };
  const command = resolveCommand("claude --model {model} {task}", {
    task: pinned,
    group,
    path: "/tmp",
    model: pinned.model ?? "claude-opus-5",
  });
  assert.match(command, /--model 'claude-haiku-4-5'/);
});

test("the column's model sits between the card's and the agent's", () => {
  const agent = { model: "claude-opus-5" } as Agent;
  const column = { ...group, model: "claude-haiku-4-5" };

  assert.equal(pickModel(task, group, agent), "claude-opus-5", "falls back to the agent");
  assert.equal(pickModel(task, column, agent), "claude-haiku-4-5", "the column overrides it");
  assert.equal(
    pickModel({ ...task, model: "claude-sonnet-5" }, column, agent),
    "claude-sonnet-5",
    "the card still wins",
  );
  assert.equal(pickModel(undefined, undefined, undefined), undefined);
});

test("a card that starts with a slash command is that command", () => {
  const command = { ...task, title: "/infra-llm-plan infra-llm/plans/fix.md" };

  assert.ok(isCommandCard(command));
  assert.ok(isCommandCard({ ...task, title: "/plan" }), "a bare command counts");
  assert.ok(isCommandCard({ ...task, title: "/dir:nested arg" }), "namespaced commands too");

  assert.ok(!isCommandCard(task), "ordinary titles do not");
  assert.ok(!isCommandCard({ ...task, title: "/ not a command" }));
  assert.ok(!isCommandCard({ ...task, title: "fix /usr/bin/thing" }), "a path is not a command");
});

// Everything after the command name is read as its arguments, so anything the
// board adds would be swallowed by it.
test("a command card is handed to the agent untouched", () => {
  const command = { ...task, title: "/infra-llm-plan plans/fix.md", body: null };
  const noisy = { ...group, prompt: "Review the change." };

  assert.equal(taskPrompt(command, noisy, "Earlier work: lots"), "/infra-llm-plan plans/fix.md");
  assert.equal(
    taskPrompt({ ...command, body: "second line" }, noisy),
    "/infra-llm-plan plans/fix.md\nsecond line",
    "a body the person wrote is kept",
  );
  assert.match(taskPrompt(task, noisy), /^Review the change\./, "ordinary cards are unchanged");
});
