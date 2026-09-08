import assert from "node:assert/strict";
import { test } from "node:test";

import { detectStatus } from "./status.ts";

test("reads the agent's own status line", () => {
  assert.equal(detectStatus("\u273b Mustering\u2026 (12s \u00b7 esc to interrupt)"), "Mustering… (12s)");
  assert.equal(detectStatus("* Thinking..."), "Thinking...");
});

// The spinner rewrites one line with carriage returns, so the raw tail is every
// frame glued together — exactly what one captured transcript looked like.
test("only the newest frame counts", () => {
  const spinner = "\u273b Mustering\u2026 (1s)\r\u273d Mustering\u2026 (2s)\r\u2736 Mustering\u2026 (3s)";
  assert.equal(detectStatus(spinner), "Mustering… (3s)");
});

test("colour codes are not part of the verb", () => {
  assert.equal(detectStatus("\x1b[38;5;208m\u273b Warping\u2026\x1b[0m (2s \u00b7 thinking)"), "Warping… (2s)");
});

test("ordinary output is not a status", () => {
  assert.equal(detectStatus("Running the tests\n42 passed\n"), null);
  assert.equal(detectStatus(""), null);
  assert.equal(detectStatus("$ npm run verify"), null);
});

test("the newest status wins over an older one", () => {
  assert.equal(detectStatus("\u273b Reading\u2026 (1s)\nedited a file\n\u273b Writing\u2026 (4s)"), "Writing… (4s)");
});

// A real agent screen: the status sits above the input box and its hints, so a
// rule that only looked at the last line or two would report nothing at all.
test("the status is found above the input box", () => {
  const screen = [
    "✻ Mustering… (12s · esc to interrupt)",
    "                    ● high · /effort",
    "────────────────────",
    "› ",
    "auto mode on (shift+tab to cycle)",
  ].join("\n");

  assert.equal(detectStatus(screen), "Mustering… (12s)");
});
