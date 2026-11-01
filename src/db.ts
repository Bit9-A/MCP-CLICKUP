import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────

export type Db = DatabaseSync;

/**
 * ClickUp timestamps surface as strings of milliseconds, numbers, or null.
 * Everything that reaches SQLite must be a valid bindable scalar.
 */
export type SqlValue = string | number | null;

export interface NormalizedTask {
  task_id: string;
  list_id: string;
  folder_id: string | null;
  space_id: string | null;
  parent_id: string | null;
  name: string;
  status: string;
  status_type: string;
  priority: number | null;
  assignees: string | null;
  tags: string | null;
  url: string | null;
  archived: number;
  date_created: number | null;
  date_updated: number | null;
  date_closed: number | null;
  date_done: number | null;
  synced_at: number;
}

export interface SyncState {
  scope: string;
  watermark: number;
  last_sync: number | null;
  last_status: string | null;
  task_count: number | null;
}

export interface ProjectRegistration {
  project: string;
  path?: string | null;
  listId: string;
  teamId?: string | null;
}

export interface CompletedQuery {
  listId?: string;
  teamId?: string;
  since?: number;
  until?: number;
  assigneeId?: number;
  limit?: number;
}

export interface WorkloadQuery {
  listId?: string;
  teamId?: string;
}

export interface CompletedTaskRow {
  task_id: string;
  list_id: string;
  name: string;
  status: string;
  status_type: string;
  assignees: string | null;
  url: string | null;
  date_closed: number | null;
  date_done: number | null;
  closed_at: number;
}

export interface WorkloadRow {
  status: string;
  status_type: string;
  assignees: string | null;
}

export interface WorkloadResult {
  total: number;
  byStatus: Record<string, number>;
  byAssignee: Array<{ id: number; open: number; closed: number }>;
}

// ── Path resolution ────────────────────────────────────────────────

/**
 * Cache location:
 *   1. CLICKUP_CACHE_DB (absolute path or ':memory:')
 *   2. ${XDG_DATA_HOME:-~/.local/share}/mcp-clickup-server/clickup.db
 */
export function resolveDbPath(): string {
  const explicit = process.env.CLICKUP_CACHE_DB?.trim();
  if (explicit) return explicit;

  const base = process.env.XDG_DATA_HOME?.trim() || joinPath(homedir(), ".local", "share");
  return joinPath(base, "mcp-clickup-server", "clickup.db");
}

// ── Migrations ─────────────────────────────────────────────────────

/**
 * Migrations are a plain ordered array: index N upgrades user_version N → N+1.
 * Adding a future schema change means appending one function, nothing else.
 */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  // v1 — task projection, project registry, sync bookkeeping.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        folder_id TEXT,
        space_id TEXT,
        parent_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        status_type TEXT NOT NULL,
        priority INTEGER,
        assignees TEXT,
        tags TEXT,
        url TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        date_created INTEGER,
        date_updated INTEGER,
        date_closed INTEGER,
        date_done INTEGER,
        synced_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_closed ON tasks(date_closed) WHERE date_closed IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(date_updated);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id) WHERE parent_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS projects (
        project TEXT PRIMARY KEY,
        path TEXT,
        list_id TEXT NOT NULL,
        team_id TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_list ON projects(list_id);

      CREATE TABLE IF NOT EXISTS sync_state (
        scope TEXT PRIMARY KEY,
        watermark INTEGER NOT NULL DEFAULT 0,
        last_sync INTEGER,
        last_status TEXT,
        task_count INTEGER
      );
    `);
  },
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number | bigint }
    | undefined;
  const current = Number(row?.user_version ?? 0);

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      MIGRATIONS[version](db);
      // user_version does not accept bound parameters, and the value is a
      // loop index — no injection surface here.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

// ── Open / connection setup ────────────────────────────────────────

/**
 * `node:sqlite` is loaded lazily through `createRequire` on purpose.
 *
 * A static import would make the whole server fail to boot on Node < 22.5,
 * taking the ClickUp tools down with it. This way the only degraded feature is
 * the local cache, and the error names the actual requirement.
 */
let DatabaseSyncCtor: (new (path: string) => DatabaseSync) | null = null;

function databaseCtor(): new (path: string) => DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  try {
    const nodeRequire = createRequire(import.meta.url);
    DatabaseSyncCtor = nodeRequire("node:sqlite").DatabaseSync as new (
      path: string,
    ) => DatabaseSync;
  } catch {
    throw new Error(
      `La caché local necesita Node 22.5 o superior (módulo node:sqlite); este proceso corre Node ${process.versions.node}. ` +
        "Actualizá Node, o seguí usando el resto de las tools sin caché.",
    );
  }
  return DatabaseSyncCtor;
}

export function openDatabase(path?: string): DatabaseSync {
  const dbPath = path ?? resolveDbPath();
  const inMemory = dbPath === ":memory:";

  if (!inMemory) {
    // No manual setup step: the cache directory and file are provisioned here.
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const DatabaseSync = databaseCtor();
  const db = new DatabaseSync(dbPath);

  // The cache holds task names, URLs and assignee ids: keep it owner-only.
  // SQLite creates -wal/-shm files with the same mode as the database file.
  if (!inMemory) {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // Filesystems without POSIX modes (or a pre-existing file owned by
      // another user) must not prevent the cache from opening.
    }
  }

  // WAL is meaningless (and unsupported) for in-memory databases.
  if (!inMemory) {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");

  migrate(db);
  return db;
}

// ── Prepared statement cache ───────────────────────────────────────

const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepare(db: DatabaseSync, sql: string): StatementSync {
  let perDb = statementCache.get(db);
  if (!perDb) {
    perDb = new Map();
    statementCache.set(db, perDb);
  }
  let stmt = perDb.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    perDb.set(sql, stmt);
  }
  return stmt;
}

// ── Normalization ──────────────────────────────────────────────────

/** Null/undefined/""/NaN are "no date"; anything numeric becomes epoch ms. */
function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses user-supplied dates: ISO strings, numeric strings of ms, or numbers.
 * Returns undefined for anything unparseable so callers can ignore the filter.
 */
export function parseDateInput(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    // Pure digits (optionally negative) are epoch ms, not years.
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : undefined;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

/** ClickUp returns priority as a `{ id }` object, a bare number, or null. */
function normalizePriority(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    return normalizePriority(id);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeTask(raw: Record<string, unknown>): NormalizedTask {
  const list = raw.list as Record<string, unknown> | undefined;
  const folder = raw.folder as Record<string, unknown> | undefined;
  const space = raw.space as Record<string, unknown> | undefined;
  const status = raw.status as Record<string, unknown> | undefined;

  const assigneeIds = Array.isArray(raw.assignees)
    ? (raw.assignees as Array<Record<string, unknown>>)
        .map((a) => a?.id)
        .filter((id): id is number | string => typeof id === "number" || typeof id === "string")
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    : [];

  const tagNames = Array.isArray(raw.tags)
    ? (raw.tags as Array<Record<string, unknown>>)
        .map((t) => t?.name)
        .filter((name): name is string => typeof name === "string")
    : [];

  return {
    task_id: String(raw.id ?? ""),
    // list_id is NOT NULL; a task without a home list falls back to "" instead
    // of breaking the sweep (the row is still queryable by id).
    list_id: list?.id != null ? String(list.id) : "",
    folder_id: folder?.id != null ? String(folder.id) : null,
    space_id: space?.id != null ? String(space.id) : null,
    parent_id: raw.parent != null && raw.parent !== "" ? String(raw.parent) : null,
    name: String(raw.name ?? ""),
    status: String(status?.status ?? ""),
    status_type: String(status?.type ?? "open"),
    priority: normalizePriority(raw.priority),
    assignees: JSON.stringify(assigneeIds),
    tags: JSON.stringify(tagNames),
    url: typeof raw.url === "string" ? raw.url : null,
    archived: raw.archived ? 1 : 0,
    date_created: toEpochMs(raw.date_created),
    date_updated: toEpochMs(raw.date_updated),
    date_closed: toEpochMs(raw.date_closed),
    date_done: toEpochMs(raw.date_done),
    synced_at: Date.now(),
  };
}

// ── Task writes ────────────────────────────────────────────────────

const UPSERT_TASK_SQL = `
  INSERT INTO tasks (
    task_id, list_id, folder_id, space_id, parent_id, name, status, status_type,
    priority, assignees, tags, url, archived, date_created, date_updated,
    date_closed, date_done, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(task_id) DO UPDATE SET
    list_id = excluded.list_id,
    folder_id = excluded.folder_id,
    space_id = excluded.space_id,
    parent_id = excluded.parent_id,
    name = excluded.name,
    status = excluded.status,
    status_type = excluded.status_type,
    priority = excluded.priority,
    assignees = excluded.assignees,
    tags = excluded.tags,
    url = excluded.url,
    archived = excluded.archived,
    date_created = excluded.date_created,
    date_updated = excluded.date_updated,
    date_closed = excluded.date_closed,
    date_done = excluded.date_done,
    synced_at = excluded.synced_at
`;

function bindTask(task: NormalizedTask): SqlValue[] {
  return [
    task.task_id,
    task.list_id,
    task.folder_id,
    task.space_id,
    task.parent_id,
    task.name,
    task.status,
    task.status_type,
    task.priority,
    task.assignees,
    task.tags,
    task.url,
    task.archived,
    task.date_created,
    task.date_updated,
    task.date_closed,
    task.date_done,
    task.synced_at,
  ];
}

/** Idempotent projection write: the ClickUp payload wins on every column. */
export function upsertTask(db: DatabaseSync, task: NormalizedTask): void {
  if (!task.task_id) return; // nothing addressable to key on
  prepare(db, UPSERT_TASK_SQL).run(...bindTask(task));
}

export function upsertMany(db: DatabaseSync, tasks: NormalizedTask[]): void {
  const rows = tasks.filter((t) => t.task_id);
  if (rows.length === 0) return;

  const stmt = prepare(db, UPSERT_TASK_SQL);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const task of rows) stmt.run(...bindTask(task));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Tombstone-by-projection. Rows not touched since `sweepStartedAt` are gone
 * from ClickUp, so they are flagged instead of deleted (history stays queryable).
 */
export function archiveMissing(db: DatabaseSync, listId: string, sweepStartedAt: number): number {
  const result = prepare(
    db,
    `UPDATE tasks SET archived = 1
       WHERE list_id = ? AND archived = 0 AND synced_at < ?`,
  ).run(listId, sweepStartedAt);
  return Number(result.changes);
}

// ── Sync state ─────────────────────────────────────────────────────

export function getSyncState(db: DatabaseSync, scope: string): SyncState | null {
  const row = prepare(
    db,
    `SELECT scope, watermark, last_sync, last_status, task_count
       FROM sync_state WHERE scope = ?`,
  ).get(scope) as Record<string, unknown> | undefined;

  if (!row) return null;
  return {
    scope: String(row.scope),
    watermark: Number(row.watermark ?? 0),
    last_sync: row.last_sync == null ? null : Number(row.last_sync),
    last_status: row.last_status == null ? null : String(row.last_status),
    task_count: row.task_count == null ? null : Number(row.task_count),
  };
}

export function setSyncState(
  db: DatabaseSync,
  scope: string,
  patch: Partial<Omit<SyncState, "scope">>,
): SyncState {
  const existing = getSyncState(db, scope);
  const next: SyncState = {
    scope,
    watermark: patch.watermark ?? existing?.watermark ?? 0,
    last_sync: patch.last_sync ?? existing?.last_sync ?? null,
    last_status: patch.last_status ?? existing?.last_status ?? null,
    task_count: patch.task_count ?? existing?.task_count ?? null,
  };

  prepare(
    db,
    `INSERT INTO sync_state (scope, watermark, last_sync, last_status, task_count)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       watermark = excluded.watermark,
       last_sync = excluded.last_sync,
       last_status = excluded.last_status,
       task_count = excluded.task_count`,
  ).run(next.scope, next.watermark, next.last_sync, next.last_status, next.task_count);

  return next;
}

// ── Projects ───────────────────────────────────────────────────────

export function registerProject(db: DatabaseSync, reg: ProjectRegistration): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    // list_id is unique, so a re-registration from another project directory
    // must release the old claim before inserting.
    prepare(db, "DELETE FROM projects WHERE list_id = ? AND project <> ?").run(reg.listId, reg.project);
    prepare(
      db,
      `INSERT INTO projects (project, path, list_id, team_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project) DO UPDATE SET
         path = excluded.path,
         list_id = excluded.list_id,
         team_id = excluded.team_id,
         updated_at = excluded.updated_at`,
    ).run(reg.project, reg.path ?? null, reg.listId, reg.teamId ?? null, Date.now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getProjectListId(db: DatabaseSync, project: string): string | null {
  const row = prepare(db, "SELECT list_id FROM projects WHERE project = ?").get(project) as
    | Record<string, unknown>
    | undefined;
  return row?.list_id == null ? null : String(row.list_id);
}

/** Lists registered for a workspace, used to scope tombstoning on team sweeps. */
export function listIdsForTeam(db: DatabaseSync, teamId: string): string[] {
  const rows = prepare(db, "SELECT list_id FROM projects WHERE team_id = ?").all(teamId) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => String(row.list_id)).filter((id) => id.length > 0);
}

// ── Queries ────────────────────────────────────────────────────────

/**
 * Shared scope filter.
 *
 * `teamId` has no column on `tasks`; it is resolved through the `projects`
 * registry, which only knows lists that were actually registered on this
 * machine. A team-wide cache therefore narrows to registered lists. Running a
 * `sync_tasks` with `teamId` also populates `tasks`, so the practical gap is
 * limited to lists never registered here.
 */
function scopeClause(listId?: string, teamId?: string): { sql: string; params: SqlValue[] } {
  if (listId) return { sql: "list_id = ?", params: [listId] };
  if (teamId) {
    return {
      sql: "list_id IN (SELECT list_id FROM projects WHERE team_id = ?)",
      params: [teamId],
    };
  }
  return { sql: "1 = 1", params: [] };
}

const DATE_CLOSED_EXPR = "COALESCE(date_closed, date_done)";

export function queryCompleted(db: DatabaseSync, query: CompletedQuery = {}): CompletedTaskRow[] {
  const { sql: scopeSql, params } = scopeClause(query.listId, query.teamId);
  const where: string[] = [
    "archived = 0",
    `(${DATE_CLOSED_EXPR}) IS NOT NULL`,
    scopeSql,
  ];

  if (query.since !== undefined) {
    where.push(`${DATE_CLOSED_EXPR} >= ?`);
    params.push(query.since);
  }
  if (query.until !== undefined) {
    where.push(`${DATE_CLOSED_EXPR} <= ?`);
    params.push(query.until);
  }
  if (query.assigneeId !== undefined) {
    // Tradeoff: assignees is a JSON array of NUMERIC ids stored as text
    // (`[1,12]`). Wrapping the de-bracketed list in commas makes an exact id
    // match possible without the JSON1 extension: `%,12,%` hits 12 but not 1.
    // The expression cannot use an index, which is fine at local cache sizes.
    where.push("(',' || TRIM(IFNULL(assignees, ''), '[]') || ',') LIKE ?");
    params.push(`%,${Math.trunc(query.assigneeId)},%`);
  }

  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
  params.push(limit);

  const rows = prepare(
    db,
    `SELECT task_id, list_id, name, status, status_type, assignees, url,
            date_closed, date_done, ${DATE_CLOSED_EXPR} AS closed_at
       FROM tasks
      WHERE ${where.join(" AND ")}
      ORDER BY ${DATE_CLOSED_EXPR} DESC
      LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    task_id: String(row.task_id),
    list_id: String(row.list_id),
    name: String(row.name),
    status: String(row.status),
    status_type: String(row.status_type),
    assignees: row.assignees == null ? null : String(row.assignees),
    url: row.url == null ? null : String(row.url),
    date_closed: row.date_closed == null ? null : Number(row.date_closed),
    date_done: row.date_done == null ? null : Number(row.date_done),
    closed_at: Number(row.closed_at),
  }));
}

export function queryWorkload(db: DatabaseSync, query: WorkloadQuery = {}): WorkloadResult {
  const { sql: scopeSql, params } = scopeClause(query.listId, query.teamId);
  const rows = prepare(
    db,
    `SELECT status, status_type, assignees FROM tasks
      WHERE archived = 0 AND ${scopeSql}`,
  ).all(...params) as Array<Record<string, unknown>>;

  const byStatus: Record<string, number> = {};
  const byAssignee = new Map<number, { id: number; open: number; closed: number }>();

  for (const row of rows) {
    const status = String(row.status ?? "—");
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    const type = String(row.status_type ?? "open");
    const isClosed = type === "closed" || type === "done";

    let ids: number[] = [];
    if (typeof row.assignees === "string" && row.assignees) {
      try {
        const parsed = JSON.parse(row.assignees) as unknown;
        if (Array.isArray(parsed)) {
          ids = parsed.map((id) => Number(id)).filter((id) => Number.isFinite(id));
        }
      } catch {
        // Corrupt JSON should not break an aggregate read.
        ids = [];
      }
    }

    for (const id of ids) {
      const entry = byAssignee.get(id) ?? { id, open: 0, closed: 0 };
      if (isClosed) entry.closed += 1;
      else entry.open += 1;
      byAssignee.set(id, entry);
    }
  }

  const assignees = [...byAssignee.values()].sort(
    (a, b) => b.open - a.open || b.closed - a.closed || a.id - b.id,
  );

  return { total: rows.length, byStatus, byAssignee: assignees };
}
