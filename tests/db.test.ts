import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveMissing,
  getSyncState,
  migrate,
  openDatabase,
  parseDateInput,
  normalizeTask,
  queryCompleted,
  queryWorkload,
  registerProject,
  setSyncState,
  upsertMany,
  upsertTask,
  type Db,
} from "../src/db.ts";

// ── Fixtures ───────────────────────────────────────────────────────

/** Minimal ClickUp task payload (shape of GET /list/{id}/task rows). */
function rawTask(overrides: {
  id: string;
  listId?: string;
  name?: string;
  status?: string;
  type?: string;
  dateClosed?: string | null;
  dateDone?: string | null;
  dateUpdated?: string;
  assignees?: number[];
  tags?: string[];
  priority?: unknown;
  parent?: string | null;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    name: overrides.name ?? `Task ${overrides.id}`,
    list: { id: overrides.listId ?? "list-1" },
    folder: { id: "folder-1" },
    space: { id: "space-1" },
    parent: overrides.parent ?? null,
    status: { status: overrides.status ?? "open", type: overrides.type ?? "open" },
    priority: overrides.priority ?? null,
    assignees: (overrides.assignees ?? []).map((id) => ({ id, username: `user-${id}` })),
    tags: (overrides.tags ?? []).map((name) => ({ name })),
    url: `https://app.clickup.com/t/${overrides.id}`,
    archived: false,
    date_created: "1700000000000",
    date_updated: overrides.dateUpdated ?? "1700000000000",
    date_closed: overrides.dateClosed ?? null,
    date_done: overrides.dateDone ?? null,
  };
}

function freshDb(): Db {
  return openDatabase(":memory:");
}

function countRows(db: Db, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return Number(row?.n ?? 0);
}

// ── Tests ──────────────────────────────────────────────────────────

test("migrate creates the schema on a fresh :memory: database", () => {
  const db = freshDb();

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>).map((r) => r.name);

  for (const table of ["tasks", "projects", "sync_state"]) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }

  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(Number(version.user_version), 1);

  // Idempotent: running it again must not throw or bump the version.
  migrate(db);
  const again = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(Number(again.user_version), 1);

  db.close();
});

test("upsertMany is idempotent and refreshes synced_at", () => {
  const db = freshDb();
  const first = normalizeTask(rawTask({ id: "t1" }));
  first.synced_at = 1000;

  upsertMany(db, [first]);
  assert.equal(countRows(db, "SELECT COUNT(*) AS n FROM tasks"), 1);

  const second = normalizeTask(rawTask({ id: "t1", name: "Renamed" }));
  second.synced_at = 2000;
  upsertMany(db, [second]);

  assert.equal(countRows(db, "SELECT COUNT(*) AS n FROM tasks"), 1);
  const row = db.prepare("SELECT name, synced_at FROM tasks WHERE task_id = 't1'").get() as {
    name: string;
    synced_at: number;
  };
  assert.equal(row.name, "Renamed");
  assert.equal(Number(row.synced_at), 2000);

  db.close();
});

test("upsertTask normalizes ClickUp payload fields", () => {
  const db = freshDb();
  const task = normalizeTask(
    rawTask({
      id: "t-normalize",
      status: "complete",
      type: "closed",
      dateClosed: "1700000500000",
      assignees: [7, 9],
      tags: ["backend", "urgent"],
      priority: { id: "2" },
      parent: "t-parent",
    }),
  );

  upsertTask(db, task);

  const row = db.prepare("SELECT * FROM tasks WHERE task_id = 't-normalize'").get() as Record<
    string,
    unknown
  >;

  assert.equal(row.list_id, "list-1");
  assert.equal(row.folder_id, "folder-1");
  assert.equal(row.space_id, "space-1");
  assert.equal(row.parent_id, "t-parent");
  assert.equal(row.status_type, "closed");
  assert.equal(Number(row.priority), 2);
  assert.equal(Number(row.date_created), 1700000000000);
  assert.equal(Number(row.date_closed), 1700000500000);
  assert.deepEqual(JSON.parse(String(row.assignees)), [7, 9]);
  assert.deepEqual(JSON.parse(String(row.tags)), ["backend", "urgent"]);

  db.close();
});

test("archiveMissing only tombstones rows older than the sweep start", () => {
  const db = freshDb();

  const stale = normalizeTask(rawTask({ id: "stale" }));
  stale.synced_at = 1_000;
  const fresh = normalizeTask(rawTask({ id: "fresh" }));
  fresh.synced_at = 5_000;
  const otherList = normalizeTask(rawTask({ id: "other", listId: "list-2" }));
  otherList.synced_at = 1_000;
  upsertMany(db, [stale, fresh, otherList]);

  const archived = archiveMissing(db, "list-1", 3_000);
  assert.equal(archived, 1); // only "stale"

  const rows = db
    .prepare("SELECT task_id, archived FROM tasks ORDER BY task_id")
    .all() as Array<{ task_id: string; archived: number }>;
  assert.deepEqual(
    rows.map((r) => [r.task_id, Number(r.archived)]),
    [
      ["fresh", 0],
      ["other", 0],
      ["stale", 1],
    ],
  );

  // Idempotent: nothing left to archive.
  assert.equal(archiveMissing(db, "list-1", 3_000), 0);

  db.close();
});

test("queryCompleted filters by date range and assignee", () => {
  const db = freshDb();

  const tasks = [
    normalizeTask(
      rawTask({
        id: "c-old",
        status: "done",
        type: "closed",
        dateClosed: "1700000000000",
        assignees: [1],
      }),
    ),
    normalizeTask(
      rawTask({
        id: "c-mid",
        status: "done",
        type: "done",
        dateDone: "1700100000000",
        assignees: [2],
      }),
    ),
    normalizeTask(
      rawTask({
        id: "c-new",
        status: "done",
        type: "closed",
        dateClosed: "1700200000000",
        assignees: [1, 2],
      }),
    ),
    normalizeTask(rawTask({ id: "c-open", status: "open", type: "open", assignees: [1] })),
  ];
  upsertMany(db, tasks);

  const all = queryCompleted(db, { listId: "list-1" });
  assert.deepEqual(
    all.map((r) => r.task_id),
    ["c-new", "c-mid", "c-old"],
  );

  const ranged = queryCompleted(db, {
    listId: "list-1",
    since: 1700050000000,
    until: 1700150000000,
  });
  assert.deepEqual(
    ranged.map((r) => r.task_id),
    ["c-mid"],
  );

  const byAssignee = queryCompleted(db, { listId: "list-1", assigneeId: 2 });
  assert.deepEqual(
    byAssignee.map((r) => r.task_id),
    ["c-new", "c-mid"],
  );

  // Substring ids must not match (12 vs 2).
  assert.deepEqual(queryCompleted(db, { listId: "list-1", assigneeId: 12 }), []);

  // Limit is honored.
  assert.equal(queryCompleted(db, { listId: "list-1", limit: 1 }).length, 1);

  // Tombstoned rows drop out.
  archiveMissing(db, "list-1", Date.now() + 1);
  assert.equal(queryCompleted(db, { listId: "list-1" }).length, 0);

  db.close();
});

test("queryWorkload aggregates by status and assignee", () => {
  const db = freshDb();

  upsertMany(db, [
    normalizeTask(rawTask({ id: "w1", status: "open", type: "open", assignees: [1] })),
    normalizeTask(rawTask({ id: "w2", status: "in progress", type: "custom", assignees: [1, 2] })),
    normalizeTask(
      rawTask({ id: "w3", status: "done", type: "closed", dateClosed: "1700000000000", assignees: [2] }),
    ),
    normalizeTask(rawTask({ id: "w4", status: "done", type: "done", dateDone: "1700000000001" })),
  ]);

  const result = queryWorkload(db, { listId: "list-1" });

  assert.equal(result.total, 4);
  assert.deepEqual(result.byStatus, { open: 1, "in progress": 1, done: 2 });

  const byId = new Map(result.byAssignee.map((a) => [a.id, a]));
  assert.deepEqual(byId.get(1), { id: 1, open: 2, closed: 0 });
  assert.deepEqual(byId.get(2), { id: 2, open: 1, closed: 1 });

  // Archived tasks leave the workload (archived after the fact).
  archiveMissing(db, "list-1", Date.now() + 1);
  assert.equal(queryWorkload(db, { listId: "list-1" }).total, 0);

  db.close();
});

test("sync state round-trips and merges partial patches", () => {
  const db = freshDb();

  assert.equal(getSyncState(db, "list:list-1"), null);

  setSyncState(db, "list:list-1", { watermark: 500, last_sync: 123, last_status: "ok", task_count: 3 });
  assert.deepEqual(getSyncState(db, "list:list-1"), {
    scope: "list:list-1",
    watermark: 500,
    last_sync: 123,
    last_status: "ok",
    task_count: 3,
  });

  setSyncState(db, "list:list-1", { last_status: "partial" });
  const merged = getSyncState(db, "list:list-1");
  assert.equal(merged?.watermark, 500);
  assert.equal(merged?.last_status, "partial");

  db.close();
});

test("registerProject keeps list_id unique and resolves by project", () => {
  const db = freshDb();

  registerProject(db, { project: "erp", path: "/repo/erp", listId: "list-1", teamId: "team-1" });
  registerProject(db, { project: "erp", path: "/repo/erp", listId: "list-1", teamId: "team-1" });

  assert.equal(countRows(db, "SELECT COUNT(*) AS n FROM projects"), 1);

  // Re-registering the same list under a new project releases the old claim.
  registerProject(db, { project: "erp-v2", path: "/repo/erp", listId: "list-1", teamId: "team-1" });

  const rows = db.prepare("SELECT project, list_id FROM projects").all() as Array<{
    project: string;
    list_id: string;
  }>;
  assert.deepEqual(
    rows.map((r) => ({ project: r.project, list_id: r.list_id })),
    [{ project: "erp-v2", list_id: "list-1" }],
  );

  const workload = queryWorkload(db, { teamId: "team-1" });
  assert.equal(workload.total, 0);

  db.close();
});

test("parseDateInput accepts ISO, ms strings and numbers; rejects junk", () => {
  assert.equal(parseDateInput("2024-01-01T00:00:00.000Z"), Date.parse("2024-01-01T00:00:00.000Z"));
  assert.equal(parseDateInput("1700000000000"), 1700000000000);
  assert.equal(parseDateInput(1700000000000), 1700000000000);
  assert.equal(parseDateInput(""), undefined);
  assert.equal(parseDateInput(null), undefined);
  assert.equal(parseDateInput(undefined), undefined);
  assert.equal(parseDateInput("not-a-date"), undefined);
  assert.equal(parseDateInput(NaN), undefined);
});
