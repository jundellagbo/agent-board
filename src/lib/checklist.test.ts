import assert from "node:assert/strict";
import { test } from "node:test";

import { formatChecklist, markStep, parseChecklist, progress, toggleStep } from "./checklist.ts";

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

test("ticking a step keeps the rest and normalises the markers", () => {
  const body = "1. first\n2. second";
  const after = toggleStep(body, 1);

  assert.equal(after, "- [ ] first\n- [x] second");
  assert.deepEqual(progress(parseChecklist(after)), { done: 1, total: 2 });
  assert.equal(toggleStep(after, 1), "- [ ] first\n- [ ] second", "and it toggles back");
});

test("an index that is not there changes nothing", () => {
  assert.equal(toggleStep("1. a\n2. b", 9), "1. a\n2. b");
  assert.equal(formatChecklist([]), "");
});

test("marking a step ticks it and leaves the rest alone", () => {
  const body = "- [ ] one\n- [ ] two";
  assert.equal(markStep(body, 1), "- [ ] one\n- [x] two");
  assert.equal(markStep(markStep(body, 1), 1), "- [ ] one\n- [x] two", "twice is once");
});

// The agent announces step numbers; a body that is prose, or a number past the
// end of the list, must never be rewritten out from under the user.
test("marking a step that is not there changes nothing", () => {
  assert.equal(markStep("- [ ] one", 4), "- [ ] one");
  assert.equal(markStep("Just a note about the work", 0), "Just a note about the work");
  assert.equal(markStep(null, 0), "");
});
