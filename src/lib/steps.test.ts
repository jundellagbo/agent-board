import assert from "node:assert/strict";
import { test } from "node:test";

import { STEP_MARK, detectSteps, stepInstruction } from "./steps.ts";

test("an announced step is read as its index", () => {
  assert.deepEqual(detectSteps(`Opened it.\n${STEP_MARK} 1\n`, 3), [0]);
  assert.deepEqual(detectSteps(`${STEP_MARK} 1\n${STEP_MARK} 3\n`, 3), [0, 2]);
});

test("nothing announced is nothing ticked", () => {
  assert.deepEqual(detectSteps("Working on it…\n", 3), []);
  assert.deepEqual(detectSteps("", 3), []);
});

// The instruction itself names the mark, and agents echo instructions back.
test("a mark quoted mid-sentence ticks nothing", () => {
  assert.deepEqual(detectSteps(stepInstruction(3), 3), []);
  assert.deepEqual(detectSteps(`I will print ${STEP_MARK} 1 when done.`, 3), []);
});

test("a step that is not on the card is ignored", () => {
  assert.deepEqual(detectSteps(`${STEP_MARK} 9\n${STEP_MARK} 0\n`, 3), []);
  assert.deepEqual(detectSteps(`${STEP_MARK} two\n`, 3), [], "it has to be a number");
});

test("the same step announced twice is one step", () => {
  assert.deepEqual(detectSteps(`${STEP_MARK} 2\nmore work\n${STEP_MARK} 2\n`, 3), [1]);
});
