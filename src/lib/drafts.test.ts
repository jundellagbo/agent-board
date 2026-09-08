import assert from "node:assert/strict";
import { test } from "node:test";

import { clearDraft, readDraft, writeDraft } from "./drafts.ts";

function withStorage(store: Map<string, string> | null) {
  globalThis.localStorage = (
    store === null
      ? {
          getItem() {
            throw new Error("storage is blocked");
          },
          setItem() {
            throw new Error("storage is blocked");
          },
          removeItem() {
            throw new Error("storage is blocked");
          },
        }
      : {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
          removeItem: (key: string) => void store.delete(key),
        }
  ) as Storage;
}

test("a draft survives being written and read back", () => {
  withStorage(new Map());
  writeDraft("todo", { title: "half a thought", agentId: "a1", model: "" });

  assert.deepEqual(readDraft("todo"), { title: "half a thought", agentId: "a1", model: "" });
  assert.equal(readDraft("other"), null, "drafts belong to their own column");

  clearDraft("todo");
  assert.equal(readDraft("todo"), null);
});

test("an empty draft is no draft", () => {
  const store = new Map<string, string>();
  withStorage(store);

  writeDraft("todo", { title: "   ", agentId: "", model: "" });
  assert.equal(readDraft("todo"), null, "an empty composer must not reopen itself");
  assert.equal(store.size, 0);
});

// Storage throws outright in some embeddings; a lost draft must not take the
// board down with it.
test("storage that refuses to work is survivable", () => {
  withStorage(null);

  assert.equal(readDraft("todo"), null);
  assert.doesNotThrow(() => writeDraft("todo", { title: "x", agentId: "", model: "" }));
  assert.doesNotThrow(() => clearDraft("todo"));
});

test("unreadable stored text is ignored, not thrown", () => {
  const store = new Map([["agent-board.draft.todo", "{not json"]]);
  withStorage(store);
  assert.equal(readDraft("todo"), null);
});
