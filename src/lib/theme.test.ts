import assert from "node:assert/strict";
import { test } from "node:test";

import { CODE_FONTS, DEFAULT_THEME, UI_FONTS, parseTheme } from "./theme.ts";

// The CSS fallback in globals.css has to agree with these, or the first frame
// of every launch paints with different values than the app settles on.
test("the shipped defaults are the ones the stylesheet starts from", () => {
  assert.equal(DEFAULT_THEME.radius, 4);
  assert.equal(DEFAULT_THEME.fontSize, 18);
  assert.equal(DEFAULT_THEME.mode, "dark");
});

// An unknown font name falls back to the head of the list, so a default that is
// not the head sends a stale stored setting somewhere nobody chose.
test("each default font leads its own list", () => {
  assert.equal(DEFAULT_THEME.uiFont, UI_FONTS[0].name);
  assert.equal(DEFAULT_THEME.codeFont, CODE_FONTS[0].name);
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
