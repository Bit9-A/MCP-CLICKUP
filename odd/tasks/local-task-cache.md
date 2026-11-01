# Local task cache (SQLite)

## Objective

Give the MCP server a local, rebuildable projection of ClickUp tasks so history
and workload questions (`get_completed_tasks`, `get_workload`) can be answered
without paying an API round-trip per query, while ClickUp remains the single
source of truth.

Three invariants drive the whole design:

1. **ClickUp is the source of truth.** The database can be deleted at any time
   and rebuilt with `sync_tasks`.
2. **Reads hit the cache, writes hit the API first.** `create_task`,
   `update_task` and `add_tag_to_task` still call ClickUp; the returned task is
   then projected into the cache (best-effort, never blocking the tool result).
3. **Nothing is deleted.** A task that disappears from a complete sweep is
   flagged `archived = 1`, preserving history for reports.

## Checklist

- [x] `src/db.ts` — `openDatabase()` factory (file-backed or `:memory:`), WAL +
      busy timeout + foreign keys, `user_version`-based migration runner, and a
      v1 schema with `tasks`, `projects`, `sync_state` plus the required indexes.
- [x] `src/db.ts` — lazy prepared-statement cache; `upsertTask`, `upsertMany`
      (single `BEGIN IMMEDIATE`, rollback on error), `archiveMissing`,
      `getSyncState` / `setSyncState`, `registerProject`, `getProjectListId`,
      `listIdsForTeam`.
- [x] `src/db.ts` — `normalizeTask()` (ms-string dates, home list/folder/space
      ids, status + status type, JSON id/name arrays, `synced_at`) and
      `parseDateInput()` (ISO / ms string / number, invalid → `undefined`).
- [x] `src/db.ts` — `queryCompleted()` (date range on
      `COALESCE(date_closed, date_done)`, exact assignee match without JSON1) and
      `queryWorkload()` (aggregation in JS, no JSON1 dependency).
- [x] `src/sync.ts` — `syncTasks()` with list/team scope, delta watermark,
      `include_closed`/`subtasks` params, one transaction per page, 100-row
      batches, 50-page cap, 429 exponential backoff (1s/2s/4s + jitter, 4
      attempts), injectable `fetchPage` for tests.
- [x] `src/clickup-client.ts` — `getListTasksRaw()` and `getTeamTasksRaw()`.
- [x] `src/index.ts` — `sync_tasks`, `get_completed_tasks`, `get_workload`
      registered and dispatched; best-effort cache upsert after create/update/tag;
      `registerProject()` inside `get_project_config`.
- [x] `tests/db.test.ts` + `tests/sync.test.ts` — 21 tests, `node:test` via tsx,
      zero network calls.
- [x] `package.json` — `npm test` script, version `1.6.0`.

## Security / safety notes

- `include_closed: true` is mandatory. Without it ClickUp hides finished tasks,
  the sweep looks complete, and every completed task gets tombstoned.
- Archiving only runs when a sweep is `complete` **and** is a full sweep
  (`watermark === 0`). A delta sweep returns only recently updated tasks, so
  running `archiveMissing` there would tombstone everything untouched.
- A failed sweep (network/API error) never tombstones and never advances the
  watermark; it reports `status: "failed"`.
- An incomplete sweep (50-page cap) reports `partial` and keeps the previous
  watermark so the next delta sweep does not skip unseen pages.
- `synced_at` uses a strictly monotonic sweep stamp, so two sweeps inside the
  same millisecond still produce a meaningful `synced_at < sweepStartedAt` test.
- Cache paths: `CLICKUP_CACHE_DB` if set, else
  `${XDG_DATA_HOME:-~/.local/share}/mcp-clickup-server/clickup.db`.

## Tradeoffs

- `queryCompleted({ teamId })` resolves the team through the `projects`
  registry: `tasks` has no `team_id` column. Lists never registered on this
  machine are not visible to a team-scoped query.
- The assignee filter builds a `,<id>,` match over the de-bracketed JSON array
  (`(',' || TRIM(assignees,'[]') || ',') LIKE '%,12,%'`). Exact and JSON1-free,
  but not indexable — acceptable for a local cache.
- Removals upstream are only detected by a full sweep (`full: true`).

## Verification evidence

```
$ npm run build
> npx tsc --project .
(exit 0)

$ npm test
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ duration_ms 7462

$ node dist/index.js  # stdio, tools/list
TOOL_COUNT=25
# 22 existing tools + sync_tasks, get_completed_tasks, get_workload
```

Manual smoke runs against a seeded cache file:

- `get_workload({ project: "demo" })` → per-status counts (`done: 1`, `open: 1`)
  and per-assignee open/closed split.
- `get_completed_tasks({ listId: "list-9", since: "2023-11-01" })` → one closed
  task with localized close date, assignee count and URL.
- `get_project_config` in a directory with `.mcp-clickup.json` → project row
  written to the `projects` table (`list-77`, `team-77`).
- Unwritable cache directory → the cache tool returns an MCP error and the
  server keeps answering `tools/list` with 25 tools (no crash).
