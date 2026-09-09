import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NO_PLAN,
  PLAN_END,
  PLAN_START,
  PLAN_INSTRUCTION,
  detectPlan,
  planStarted,
} from "./plan.ts";

test("no decision until the agent makes one", () => {
  assert.equal(detectPlan("Reading the codebase...\n"), null);
  assert.equal(detectPlan(""), null);
});

test("a simple card is allowed to skip planning", () => {
  assert.deepEqual(detectPlan(`Looks like a one-liner.\n${NO_PLAN}\n`), { type: "none" });
});

test("a plan becomes the card's checklist", () => {
  const output = `${PLAN_START}\n1. Read the migration\n2. Add the column\n\n3. Backfill\n${PLAN_END}\nStarting.`;

  assert.deepEqual(detectPlan(output), {
    type: "plan",
    body: "1. Read the migration\n2. Add the column\n3. Backfill",
  });
});

test("a half-written plan is not a decision yet", () => {
  assert.equal(detectPlan(`${PLAN_START}\n1. Read the migration\n`), null);
  assert.equal(detectPlan(`${PLAN_START}\n${PLAN_END}\n`), null, "an empty plan is no plan");
});

// The instruction itself names all three marks, and agents echo instructions.
test("the instruction being quoted does not decide anything", () => {
  assert.equal(detectPlan(PLAN_INSTRUCTION), null);
  assert.equal(detectPlan(`I will print ${NO_PLAN} if this is simple.`), null);
});

test("planning is only the stretch between the marks", () => {
  assert.equal(planStarted("Reading the code...\n"), false, "not planning yet");
  assert.equal(planStarted(`${PLAN_START}\n1. Read the migration\n`), true);
  assert.equal(
    planStarted(`${PLAN_START}\n1. Read it\n${PLAN_END}\nWorking.`),
    false,
    "the plan is written, so the agent is working now",
  );
  assert.equal(planStarted(`${NO_PLAN}\n`), false, "a card that needs no plan never shows one");
  assert.equal(planStarted(PLAN_INSTRUCTION), false, "quoting the instruction is not planning");
});

test("a plan drawn inside the agent's box is still read", () => {
  const decision = detectPlan(
    `│ ⏺ ${PLAN_START}      │\n│ 1. open the site │\n│ 2. fix it        │\n│ ⏺ ${PLAN_END}    │\n`,
  );
  assert.deepEqual(decision, { type: "plan", body: "1. open the site\n2. fix it" });
});
