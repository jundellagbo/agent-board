import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_THEME, parseTheme } from "./theme.ts";

// The CSS fallback in globals.css has to agree with these, or the first frame
// of every launch paints with different values than the app settles on.
test("the shipped defaults are the ones the stylesheet starts from", () => {
  assert.equal(DEFAULT_THEME.radius, 4);
  assert.equal(DEFAULT_THEME.fontSize, 18);
});

test("a stored theme fills in anything it is missing", () => {
  const stored = parseTheme(JSON.stringify({ mode: "light", accent: "Rose" }));
  assert.equal(stored.mode, "light");
  assert.equal(stored.accent, "Rose");
  assert.equal(stored.radius, DEFAULT_THEME.radius, "unset keys keep the default");
});

test("unreadable settings never leave the app unstyled", () => {
  assert.deepEqual(parseTheme("{not json"), DEFAULT_THEME);
  assert.deepEqual(parseTheme(undefined), DEFAULT_THEME);
});
