import assert from "node:assert/strict";
import { test } from "node:test";

import { looksLikeGithub } from "./github.ts";

test("tells a link from a sentence", () => {
  for (const input of [
    "https://github.com/anthropics/claude-code/issues/42",
    "github.com/owner/repo/pull/7",
    "  owner/repo/issues/9  ",
  ]) {
    assert.ok(looksLikeGithub(input), `${input} should be recognised`);
  }

  for (const input of [
    "Fix the flaky test",
    "https://github.com/owner/repo",
    "see issues/42 for context",
    "",
  ]) {
    assert.ok(!looksLikeGithub(input), `${input} should not be recognised`);
  }
});
