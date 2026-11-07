import assert from "node:assert/strict";
import { test } from "node:test";

import { parseChecklist } from "./checklist.ts";

test("a numbered list is the work, in order", () => {
  const steps = parseChecklist("1. Add the parser\n2. Show it on the card\n3. Let the agent tick it");

  assert.deepEqual(
    steps.map((step) => step.text),
    ["Add the parser", "Show it on the card", "Let the agent tick it"],
  );
  assert.ok(steps.every((step) => !step.done));
});

test("bullets and checkboxes say the same thing", () => {
  assert.equal(parseChecklist("- one\n- two").length, 2);
  assert.equal(parseChecklist("1) one\n2) two").length, 2);

  const mixed = parseChecklist("- [x] done already\n- [ ] still to do");
  assert.deepEqual(
    mixed.map((step) => step.done),
    [true, false],
  );
});

// Otherwise every card with a two-line description grows a progress bar.
test("prose is a description, not a checklist", () => {
  assert.deepEqual(parseChecklist("Fix the flaky test in the runner suite."), []);
  assert.deepEqual(parseChecklist("Some context.\nAnd a second paragraph."), []);
  assert.deepEqual(parseChecklist(null), []);
  assert.deepEqual(parseChecklist("Some context.\n1. but this line is a step"), [], "mixed is prose");
});

// A single step is still a list; the count was never the signal.
test("one item is a checklist too", () => {
  assert.deepEqual(parseChecklist("- [ ] just the one"), [{ text: "just the one", done: false }]);
  assert.deepEqual(parseChecklist("1. only one step"), [{ text: "only one step", done: false }]);
});
