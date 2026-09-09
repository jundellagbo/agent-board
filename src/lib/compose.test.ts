import assert from "node:assert/strict";
import { test } from "node:test";

import { appendPath, commandName, splitCard } from "./compose.ts";

test("one line is just a title", () => {
  assert.deepEqual(splitCard("Fix the flaky test"), {
    title: "Fix the flaky test",
    body: null,
  });
  assert.deepEqual(splitCard("  padded  "), { title: "padded", body: null });
});

// The whole point: this used to arrive as one very long title, so the checklist
// support never saw it.
test("a title followed by a numbered list keeps the list as the body", () => {
  assert.deepEqual(splitCard("Ship the parser\n1. Read the input\n2. Write the output"), {
    title: "Ship the parser",
    body: "1. Read the input\n2. Write the output",
  });
});

test("a blank line between the two is typing, not content", () => {
  assert.deepEqual(splitCard("Ship it\n\n\n1. one\n2. two"), {
    title: "Ship it",
    body: "1. one\n2. two",
  });
});

// This is what was broken: the list was cut in half, and the single line left
// in the body no longer read as a list, so no checklist ever appeared.
test("a card that is all list keeps the whole list", () => {
  assert.deepEqual(splitCard("1. open facebook.com\n2. open mybizniche.com"), {
    title: "open facebook.com",
    body: "1. open facebook.com\n2. open mybizniche.com",
  });

  assert.deepEqual(splitCard("- [ ] first\n- [x] second"), {
    title: "first",
    body: "- [ ] first\n- [x] second",
  });
});

test("nothing typed is nothing", () => {
  assert.deepEqual(splitCard("   \n  "), { title: "", body: null });
});

test("a line that starts with a command says which one", () => {
  assert.equal(commandName("/infra-llm-plan plans/fix.md"), "/infra-llm-plan");
  assert.equal(commandName("  /plan  "), "/plan");
  assert.equal(commandName("/dir:nested arg"), "/dir:nested");

  assert.equal(commandName("Fix the flaky test"), null);
  assert.equal(commandName("fix /usr/bin/thing"), null, "a path is not a command");
  assert.equal(commandName("/ not a command"), null);
});

test("an attached file is named where the writing left off", () => {
  assert.equal(appendPath("Check this screenshot:", "/tmp/a.png"), "Check this screenshot: /tmp/a.png");
  assert.equal(appendPath("", "/tmp/a.png"), "/tmp/a.png", "nothing typed yet is just the path");
  assert.equal(
    appendPath("Look at this\n", "/tmp/a.png"),
    "Look at this\n/tmp/a.png",
    "a newline already there puts it on its own line",
  );
  assert.equal(
    appendPath("1. open it\n2. compare with", "/tmp/a.png"),
    "1. open it\n2. compare with /tmp/a.png",
    "a checklist stays a checklist",
  );
});
