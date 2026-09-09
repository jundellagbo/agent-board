import assert from "node:assert/strict";
import { test } from "node:test";

import { markLines, undecorate } from "./marks.ts";

test("a boxed and bulleted line comes back bare", () => {
  assert.equal(undecorate("│ ⏺ AGENT-BOARD: DONE          │"), "AGENT-BOARD: DONE");
  assert.equal(undecorate("> AGENT-BOARD: STEP 2"), "AGENT-BOARD: STEP 2");
});

test("list markers survive, because a plan is read through this too", () => {
  assert.equal(undecorate("│ - [ ] open the site │"), "- [ ] open the site");
  assert.equal(undecorate("1. open the site"), "1. open the site");
});

test("escape codes come off with the decoration", () => {
  assert.deepEqual(markLines("\x1b[32m⏺ done\x1b[0m\nnext\n"), ["done", "next", ""]);
});
