import assert from "node:assert/strict";
import { test } from "node:test";

import { recentLines } from "./recent.ts";

test("the input box and footer under the bottom rules are left out", () => {
  const screen = [
    "● Opened facebook.com",
    "",
    "● All three are open.",
    "✻ Jitterbugging… (12s)",
    "──────────────────────",
    "❯ ",
    "──────────────────────",
    "  ⏵⏵ auto mode on",
  ].join("\n");

  assert.deepEqual(recentLines(screen, 2), ["● All three are open.", "✻ Jitterbugging… (12s)"]);
});

test("a plain shell keeps its last non-empty lines", () => {
  assert.deepEqual(recentLines("a\nb\n\nc\n\n", 2), ["b", "c"]);
  assert.deepEqual(recentLines(""), []);
});
