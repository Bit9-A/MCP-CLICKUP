import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTags } from "../src/clickup-client.ts";

// `PUT /task` silently ignores `tags`, so the client reconciles through the
// add/remove endpoints. These tests pin the diff that decides those calls.

test("diffTags: identical sets need no requests", () => {
  assert.deepEqual(diffTags(["area:backend", "type:bug"], ["type:bug", "area:backend"]), {
    add: [],
    remove: [],
  });
});

test("diffTags: adds only the missing tags", () => {
  assert.deepEqual(diffTags(["area:backend"], ["area:backend", "type:feature"]), {
    add: ["type:feature"],
    remove: [],
  });
});

test("diffTags: removes only the extra tags", () => {
  assert.deepEqual(diffTags(["area:backend", "type:deuda"], ["area:backend"]), {
    add: [],
    remove: ["type:deuda"],
  });
});

test("diffTags: handles additions and removals in one pass", () => {
  assert.deepEqual(diffTags(["area:backend", "type:deuda"], ["area:frontend", "type:feature"]), {
    add: ["area:frontend", "type:feature"],
    remove: ["area:backend", "type:deuda"],
  });
});

test("diffTags: dedupes, trims and drops empty names", () => {
  assert.deepEqual(diffTags([], ["  area:qa ", "area:qa", "", "   "]), {
    add: ["area:qa"],
    remove: [],
  });
});

test("diffTags: tag names are case-sensitive, as in ClickUp", () => {
  assert.deepEqual(diffTags(["Area:qa"], ["area:qa"]), {
    add: ["area:qa"],
    remove: ["Area:qa"],
  });
});

test("diffTags: an empty desired list removes everything", () => {
  assert.deepEqual(diffTags(["area:qa", "type:bug"], []), {
    add: [],
    remove: ["area:qa", "type:bug"],
  });
});
