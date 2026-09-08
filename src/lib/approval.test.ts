import assert from "node:assert/strict";
import { test } from "node:test";

import { detectApproval, stripAnsi } from "./approval.ts";

test("colour codes never hide a prompt", () => {
  const coloured = "\x1b[1;33mContinue?\x1b[0m (y/n) ";
  assert.equal(stripAnsi(coloured), "Continue? (y/n) ");
  assert.ok(detectApproval(coloured));
});

test("recognises how agents actually ask", () => {
  for (const output of [
    "Run `rm -rf build`? (y/n) ",
    "Proceed [Y/n]:",
    "Do you want to proceed?\n  > 1. Yes\n    2. No, tell Claude what to do differently",
    "Add file to the chat? (Y)es/(N)o [Yes]:",
    "Allow this command to run? ",
    "Press Enter to continue",
    // Claude Code's workspace trust prompt, seen verbatim in the app.
    "\u276f No, exit\n  Yes, I trust this folder\n\nEnter to confirm \u00b7 Esc to cancel",
  ]) {
    assert.ok(detectApproval(output), `should detect: ${output.slice(0, 40)}`);
  }
});

test("ordinary output is not a question", () => {
  for (const output of [
    "Running tests...\n42 passed",
    "warning: unused variable `x`",
    "",
  ]) {
    assert.ok(!detectApproval(output), `should ignore: ${output.slice(0, 40)}`);
  }
});

// The shape an agent actually draws: a bordered box, well above the input line.
test("a boxed confirmation is still a question", () => {
  const screen = [
    "\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e",
    "\u2502 Do you want to proceed?      \u2502",
    "\u2502                              \u2502",
    "\u2502 \u276f 1. Yes                     \u2502",
    "\u2502   2. No, tell Claude what to  \u2502",
    "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f",
    "",
    "\u203a ",
    "auto mode on (shift+tab to cycle)",
  ].join("\n");

  assert.ok(detectApproval(screen), "the box sits above the input line and its hints");
});

test("once the agent redraws without the question, it is not asking", () => {
  const after = "Applied 3 edits.\nRunning the test suite...\n\n\u203a \nauto mode on";
  assert.ok(!detectApproval(after));
});
