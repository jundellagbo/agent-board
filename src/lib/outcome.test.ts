import assert from "node:assert/strict";
import { test } from "node:test";

import { BLOCKED_MARK, DONE_MARK, detectOutcome } from "./outcome.ts";

test("nothing is announced until the agent says so", () => {
  assert.equal(detectOutcome("Running the tests...\nAll green.\n"), null);
  assert.equal(detectOutcome(""), null);
});

test("the agent can report finishing or being blocked", () => {
  assert.equal(detectOutcome(`Edited 3 files.\n${DONE_MARK}\n`), "done");
  assert.equal(detectOutcome(`I cannot do this safely.\n${BLOCKED_MARK}\n`), "blocked");
});

test("colour codes do not hide the mark", () => {
  assert.equal(detectOutcome(`\x1b[32m${DONE_MARK}\x1b[0m`), "done");
});

// The instruction naming both marks is itself in the prompt, and agents echo
// their instructions back constantly.
test("a mark quoted mid-sentence does not end the run", () => {
  const echoed = `I will print ${DONE_MARK} when the work is complete.\nStarting now.\n`;
  assert.equal(detectOutcome(echoed), null);
});

test("the last word wins", () => {
  assert.equal(detectOutcome(`${DONE_MARK}\nActually, one more thing.\n${BLOCKED_MARK}`), "blocked");
});

test("the mark is read through the agent's own box and bullet", () => {
  assert.equal(detectOutcome(`⏺ ${DONE_MARK}\n`), "done");
  assert.equal(detectOutcome(`│ ⏺ ${BLOCKED_MARK}   │\n`), "blocked");
});

// The instruction naming the mark is in the agent's own transcript, wrapped to
// the terminal's width — a wrap landing just before the mark used to end the
// run before it had started.
test("a wrapped instruction that begins with the mark is not an announcement", () => {
  assert.equal(detectOutcome(`${DONE_MARK} on its own line. If you cannot finish —\n`), null);
  assert.equal(detectOutcome(`${DONE_MARK}.\n`), "done", "the agent's own full stop is fine");
});
