import assert from "node:assert/strict";
import { test } from "node:test";

import { hasGoneIdle } from "./idle.ts";

const AFTER = 45_000;
const now = 1_000_000;
const still = { ready: true, waiting: false, settledAt: now - AFTER, closed: false };

test("a session that has stood still long enough is finished", () => {
  assert.equal(hasGoneIdle(still, now, AFTER), true);
  assert.equal(hasGoneIdle({ ...still, settledAt: now - 1000 }, now, AFTER), false);
});

// This is the regression: a working agent whose status line went unrecognised
// looked idle, and the card claimed Done while it was still going.
test("stillness is the only test — a missing status line is not one", () => {
  const working = { ...still, settledAt: now - 2000 };
  assert.equal(hasGoneIdle(working, now, AFTER), false, "it changed the screen 2s ago");
});

test("waiting on an answer is never finished, however long it waits", () => {
  assert.equal(hasGoneIdle({ ...still, waiting: true }, now, AFTER), false);
});

// `ready` here means the session has drawn something, not that it showed a
// status line — an agent that never shows one still has to be swept up.
test("a session that never started, or already closed, is not swept", () => {
  assert.equal(hasGoneIdle({ ...still, ready: false }, now, AFTER), false);
  assert.equal(hasGoneIdle({ ...still, closed: true }, now, AFTER), false);
});
