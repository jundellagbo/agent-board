import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_NOTIFICATIONS,
  approvalMessage,
  completionMessage,
  parseNotifications,
} from "./notify.ts";
import type { Task } from "./types";

const task = { title: "Fix the flaky test" } as Task;

test("the message says which card and how it went", () => {
  assert.equal(
    completionMessage(task, "agent-board", 0),
    "agent-board: “Fix the flaky test” finished",
  );
  assert.equal(
    completionMessage(task, "agent-board", 2),
    "agent-board: “Fix the flaky test” failed (exit 2)",
  );
});

test("a malformed webhook list never becomes one", () => {
  const config = parseNotifications(JSON.stringify({ desktop: false, webhooks: "nope" }));
  assert.equal(config.desktop, false);
  assert.deepEqual(config.webhooks, [], "a non-array must not reach the sender");

  assert.deepEqual(parseNotifications("{broken"), DEFAULT_NOTIFICATIONS);
});

test("an approval reads as a question, not a result", () => {
  assert.equal(
    approvalMessage(task, "agent-board"),
    "agent-board: “Fix the flaky test” is waiting for you",
  );
});

test("older settings gain the approval switch turned on", () => {
  const stored = parseNotifications(JSON.stringify({ desktop: true, onlyFailures: true }));
  assert.equal(stored.approvals, true, "a question is the thing you cannot discover late");
});
