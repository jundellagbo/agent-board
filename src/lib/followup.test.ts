import assert from "node:assert/strict";
import { test } from "node:test";

import { parseChecklist } from "./checklist.ts";
import { withFollowUp } from "./followup.ts";

test("a follow-up on a plain card is another paragraph", () => {
  assert.equal(withFollowUp("Some context.", "Also check the logs"), "Some context.\n\nAlso check the logs");
  assert.equal(withFollowUp(null, "Do the thing"), "Do the thing");
  assert.equal(withFollowUp("kept", "   "), "kept", "nothing typed changes nothing");
});

// Appending a paragraph would leave one line that is not a list item, and the
// whole checklist would stop being read as one.
test("a follow-up on a checklist becomes another step", () => {
  const body = "1. first\n2. second";
  const after = withFollowUp(body, "third thing");

  assert.equal(after, "1. first\n2. second\n- [ ] third thing");
  assert.equal(parseChecklist(after).length, 3, "it is still a checklist");
  assert.equal(parseChecklist(after)[2].text, "third thing");
});
