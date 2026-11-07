import assert from "node:assert/strict";
import { test } from "node:test";

import { mentionedFiles } from "./mentioned.ts";

test("screenshots and reports an agent names are picked out", () => {
  const output = [
    "Saved screenshot to /tmp/shots/home.png.",
    'filePath: "/home/me/report.md"',
    "(see ~/Desktop/diff.patch)",
    "Edited /home/me/repo/src/main.rs",
    "https://example.com/logo.png",
  ].join("\n");

  assert.deepEqual(mentionedFiles(output, "/home/me"), [
    "/tmp/shots/home.png",
    "/home/me/report.md",
    "/home/me/Desktop/diff.patch",
  ]);
});

test("the same path twice is listed once", () => {
  assert.deepEqual(mentionedFiles("/a/b.png and /a/b.png"), ["/a/b.png"]);
});
