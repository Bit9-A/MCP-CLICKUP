import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, registerProject, upsertMany, normalizeTask, setSyncState, type Db } from "../src/db.ts";
import { createFetchPage, syncTasks, type FetchPageArgs } from "../src/sync.ts";
import type { ClickUpClient } from "../src/clickup-client.ts";

// ── Fixtures ───────────────────────────────────────────────────────

function rawTask(id: string, overrides: {
  listId?: string;
  dateUpdated?: number;
  dateClosed?: number | null;
  status?: string;
  type?: string;
} = {}): Record<string, unknown> {
  return {
    id,
    name: `Task ${id}`,
    list: { id: overrides.listId ?? "list-1" },
    folder: null,
    space: null,
    parent: null,
    status: {
      status: overrides.status ?? "open",
      type: overrides.type ?? "open",
    },
    priority: null,
    assignees: [],
    tags: [],
    url: `https://app.clickup.com/t/${id}`,
    archived: false,
    date_created: "1700000000000",
    date_updated: String(overrides.dateUpdated ?? 1700000000000),
    date_closed: overrides.dateClosed ? String(overrides.dateClosed) : null,
    date_done: null,
  };
}

function makePage(count: number, prefix: string, overrides: Parameters<typeof rawTask>[1] = {}) {
  return Array.from({ length: count }, (_, i) => rawTask(`${prefix}-${i}`, overrides));
}

function freshDb(): Db {
  return openDatabase(":memory:");
}

function archivedCount(db: Db, taskId: string): number {
  const row = db.prepare("SELECT archived FROM tasks WHERE task_id = ?").get(taskId) as
    | { archived: number }
    | undefined;
  return row ? Number(row.archived) : -1;
}

/** Fake client that records the params of every HTTP call, no network involved. */
function fakeClient(handler: (params: Record<string, string | number | boolean>) => {
  tasks: Array<Record<string, unknown>>;
}): { client: ClickUpClient; calls: Array<Record<string, string | number | boolean>> } {
  const calls: Array<Record<string, string | number | boolean>> = [];
  const respond = (params: Record<string, string | number | boolean>) => {
    calls.push({ ...params });
    return handler(params);
  };
  const client = {
    getListTasksRaw: async (_listId: string, params: Record<string, string | number | boolean>) =>
      respond(params),
    getTeamTasksRaw: async (_teamId: string, params: Record<string, string | number | boolean>) =>
      respond(params),
  } as unknown as ClickUpClient;
  return { client, calls };
}

// ── Tests ──────────────────────────────────────────────────────────

test("page boundary: 100 tasks on page 0 requires one empty page to prove completeness", async () => {
  const db = freshDb();
  const requested: number[] = [];

  const fetchPage = async ({ page }: FetchPageArgs) => {
    requested.push(page);
    return page === 0 ? makePage(100, "p0") : [];
  };

  const result = await syncTasks(db, { client: null as unknown as ClickUpClient, listId: "list-1", fetchPage });

  assert.equal(result.synced, 100);
  assert.equal(result.pages, 2);
  assert.equal(result.status, "ok");
  // Page 1 is the stop signal; page 2 must never be requested.
  assert.deepEqual(requested, [0, 1]);
  assert.equal(result.archived, 0);

  db.close();
});

test("page boundary: a short page stops the sweep immediately", async () => {
  const db = freshDb();
  const requested: number[] = [];

  const fetchPage = async ({ page }: FetchPageArgs) => {
    requested.push(page);
    return page === 0 ? makePage(42, "short") : [];
  };

  const result = await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    listId: "list-1",
    fetchPage,
  });

  assert.equal(result.synced, 42);
  assert.equal(result.pages, 1);
  assert.equal(result.status, "ok");
  assert.deepEqual(requested, [0]);

  db.close();
});

test("a failing sweep never tombstones and reports failed", async () => {
  const db = freshDb();

  // Pre-existing cache from an earlier sweep.
  const seeded = normalizeTask(rawTask("pre-existing"));
  seeded.synced_at = 1_000;
  upsertMany(db, [seeded]);
  setSyncState(db, "list:list-1", { watermark: 1_000, last_status: "ok", task_count: 1 });

  const fetchPage = async ({ page }: FetchPageArgs) => {
    if (page < 2) return makePage(100, `p${page}`);
    throw new Error("ECONNRESET");
  };

  const result = await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    listId: "list-1",
    fetchPage,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.archived, 0);
  assert.equal(archivedCount(db, "pre-existing"), 0);

  const state = db.prepare("SELECT watermark, last_status FROM sync_state WHERE scope = 'list:list-1'").get() as {
    watermark: number;
    last_status: string;
  };
  assert.equal(state.last_status, "failed");
  assert.equal(Number(state.watermark), 1_000); // unchanged

  db.close();
});

test("closed tasks stay visible and are not archived by a successful sweep", async () => {
  const db = freshDb();

  const fetchPage = async ({ page }: FetchPageArgs) =>
    page === 0
      ? [
          ...makePage(3, "open", { status: "open", type: "open" }),
          ...makePage(2, "closed", { status: "done", type: "closed", dateClosed: 1700000100000 }),
        ]
      : [];

  const result = await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    listId: "list-1",
    fetchPage,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.synced, 5);
  assert.equal(result.archived, 0);
  assert.equal(archivedCount(db, "closed-0"), 0);
  assert.equal(archivedCount(db, "closed-1"), 0);

  db.close();
});

test("a task removed upstream is archived only after a complete full sweep", async () => {
  const db = freshDb();

  const firstSweep = async ({ page }: FetchPageArgs) =>
    page === 0 ? [rawTask("keep"), rawTask("remove")] : [];
  await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    listId: "list-1",
    fetchPage: firstSweep,
    full: true,
  });

  assert.equal(archivedCount(db, "keep"), 0);
  assert.equal(archivedCount(db, "remove"), 0);

  // Second complete full sweep: "remove" is gone from ClickUp.
  const secondSweep = async ({ page }: FetchPageArgs) =>
    page === 0 ? [rawTask("keep")] : [];
  const result = await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    listId: "list-1",
    fetchPage: secondSweep,
    full: true,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.archived, 1);
  assert.equal(archivedCount(db, "keep"), 0);
  assert.equal(archivedCount(db, "remove"), 1);

  db.close();
});

test("a delta sweep after a watermark never archives untouched tasks", async () => {
  const db = freshDb();

  await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    listId: "list-1",
    fetchPage: async ({ page }) => (page === 0 ? [rawTask("a"), rawTask("b")] : []),
    full: true,
  });

  const delta = await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    listId: "list-1",
    fetchPage: async ({ page }) => (page === 0 ? [rawTask("a", { dateUpdated: 1700000999000 })] : []),
  });

  assert.equal(delta.status, "ok");
  assert.equal(delta.archived, 0);
  assert.equal(archivedCount(db, "b"), 0);
  assert.equal(archivedCount(db, "a"), 0);

  db.close();
});

test("delta sweeps pass the watermark and ask ClickUp for date_updated_gt", async () => {
  const db = freshDb();
  const { client, calls } = fakeClient((params) => {
    const pageNo = Number(params.page ?? 0);
    if (pageNo > 0) return { tasks: [] };
    return { tasks: [rawTask("a", { dateUpdated: 1700000500000 })] };
  });

  const first = await syncTasks(db, { client, listId: "list-1" });
  assert.equal(first.watermark, 1700000500000);
  assert.equal(calls[0].include_closed, true);
  assert.equal(calls[0].subtasks, true);
  assert.equal(calls[0].include_subtasks, true);
  assert.equal(calls[0].date_updated_gt, undefined);

  const injected: number[] = [];
  const fetchPage = async ({ watermark, page }: FetchPageArgs) => {
    injected.push(watermark);
    return page === 0 ? [rawTask("a", { dateUpdated: 1700000900000 })] : [];
  };

  const second = await syncTasks(db, { client, listId: "list-1", fetchPage });
  assert.equal(injected[0], 1700000500000);
  assert.equal(second.watermark, 1700000900000);

  // Client-backed path also forwards the watermark as date_updated_gt.
  calls.length = 0;
  await syncTasks(db, { client, listId: "list-1" });
  assert.equal(calls[0].date_updated_gt, 1700000900000);

  db.close();
});

test("full sweep resets the watermark filter to zero", async () => {
  const db = freshDb();
  const { client, calls } = fakeClient((params) =>
    Number(params.page ?? 0) === 0 ? { tasks: [rawTask("a", { dateUpdated: 1700000500000 })] } : { tasks: [] },
  );

  await syncTasks(db, { client, listId: "list-1" });
  calls.length = 0;
  await syncTasks(db, { client, listId: "list-1", full: true });

  assert.equal(calls[0].date_updated_gt, undefined);

  db.close();
});

test("team scope sweeps archive per list seen in the sweep", async () => {
  const db = freshDb();

  // Team sweeps only tombstone lists they know about: registered ones plus the
  // lists actually seen in the sweep.
  registerProject(db, { project: "p1", listId: "list-1", teamId: "team-1" });
  registerProject(db, { project: "p2", listId: "list-2", teamId: "team-1" });

  await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    teamId: "team-1",
    fetchPage: async ({ page }) =>
      page === 0
        ? [rawTask("l1-a", { listId: "list-1" }), rawTask("l2-a", { listId: "list-2" })]
        : [],
    full: true,
  });

  const result = await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    teamId: "team-1",
    fetchPage: async ({ page }) => (page === 0 ? [rawTask("l1-a", { listId: "list-1" })] : []),
    full: true,
  });

  assert.equal(result.archived, 1);
  assert.equal(archivedCount(db, "l2-a"), 1);
  assert.equal(archivedCount(db, "l1-a"), 0);

  db.close();
});

test("a sweep that hits the page cap is partial: no archiving and no watermark advance", async () => {
  const db = freshDb();

  const seeded = normalizeTask(rawTask("stale"));
  seeded.synced_at = 1_000;
  upsertMany(db, [seeded]);
  setSyncState(db, "list:list-1", { watermark: 1_000, last_status: "ok", task_count: 1 });

  let calls = 0;
  const result = await syncTasks(db, {
    client: null as unknown as ClickUpClient,
    listId: "list-1",
    fetchPage: async ({ page }) => {
      calls += 1;
      return makePage(100, `cap-${page}`, { dateUpdated: 1700000000000 + page });
    },
  });

  assert.equal(calls, 50); // MAX_PAGES safety valve
  assert.equal(result.pages, 50);
  assert.equal(result.status, "partial");
  assert.equal(result.archived, 0);
  assert.equal(result.watermark, 1_000); // not advanced past unseen pages
  assert.equal(archivedCount(db, "stale"), 0);

  db.close();
});

test("syncTasks rejects calls without listId or teamId", async () => {
  const db = freshDb();
  await assert.rejects(
    () => syncTasks(db, { client: null as unknown as ClickUpClient }),
    /listId or teamId/,
  );
  db.close();
});

test("createFetchPage retries HTTP 429 with backoff and then fails", async () => {
  let attempts = 0;
  const client = {
    getListTasksRaw: async () => {
      attempts += 1;
      throw { response: { status: 429 }, message: "rate limited" };
    },
  } as unknown as ClickUpClient;

  const fetchPage = createFetchPage(client);
  await assert.rejects(() => fetchPage({ scope: "list", id: "list-1", page: 0, watermark: 0 }));
  assert.equal(attempts, 4); // 1 try + 3 backoff retries
});
