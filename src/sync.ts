import type { ClickUpClient } from "./clickup-client.js";
import {
  archiveMissing,
  getSyncState,
  listIdsForTeam,
  normalizeTask,
  setSyncState,
  upsertMany,
  type Db,
} from "./db.js";

/** ClickUp v2 caps page size at 100 for task list endpoints. */
const PAGE_SIZE = 100;
/** Safety valve so a pathological sweep cannot run forever. */
const MAX_PAGES = 50;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_ATTEMPTS = 4;

export interface FetchPageArgs {
  scope: "list" | "team";
  id: string;
  page: number;
  watermark: number;
}

export type FetchPage = (args: FetchPageArgs) => Promise<Array<Record<string, unknown>>>;

export interface SyncOptions {
  client: ClickUpClient;
  listId?: string;
  teamId?: string;
  full?: boolean;
  /** Test seam: replaces the client-backed fetcher entirely (no network). */
  fetchPage?: FetchPage;
}

export interface SyncResult {
  synced: number;
  pages: number;
  archived: number;
  status: "ok" | "partial" | "failed";
  durationMs: number;
  watermark: number;
}

function isRateLimited(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    (error as { response?: { status?: number } }).response?.status === 429
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strictly monotonic sweep stamp (milliseconds).
 *
 * `Date.now()` alone is not enough: two sweeps can land in the same millisecond,
 * and tombstoning compares `synced_at < sweepStartedAt`. A counter guarantees
 * the current sweep always has a boundary above every row written before it,
 * while rows touched by the current sweep carry exactly that boundary.
 */
let lastSweepStamp = 0;

function nextSweepStamp(): number {
  const now = Date.now();
  lastSweepStamp = now > lastSweepStamp ? now : lastSweepStamp + 1;
  return lastSweepStamp;
}

/**
 * Client-backed page fetcher with rate-limit handling.
 *
 * CRITICAL: `include_closed: true` is not optional. ClickUp hides closed tasks
 * by default; without it every completed task is missing from the sweep, so the
 * "archive what the sweep did not see" step would tombstone all finished work.
 */
export function createFetchPage(client: ClickUpClient): FetchPage {
  return async ({ scope, id, page, watermark }) => {
    const params: Record<string, string | number | boolean> = {
      include_closed: true, // see note above — do not remove
      subtasks: true,
      include_subtasks: true,
      page,
    };
    // Delta sweeps only ask for tasks touched after the last known update.
    if (watermark > 0) params.date_updated_gt = watermark;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const data =
          scope === "list"
            ? await client.getListTasksRaw(id, params)
            : await client.getTeamTasksRaw(id, params);
        return (data.tasks ?? []) as Array<Record<string, unknown>>;
      } catch (error) {
        const isLast = attempt === MAX_ATTEMPTS - 1;
        if (!isRateLimited(error) || isLast) throw error;
        const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        // Exponential backoff plus jitter so parallel clients do not sync up.
        await sleep(base + Math.floor(Math.random() * 250));
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new Error("Rate limit retries exhausted");
  };
}

export async function syncTasks(db: Db, opts: SyncOptions): Promise<SyncResult> {
  const startedAt = Date.now();
  const scope: "list" | "team" | null = opts.listId ? "list" : opts.teamId ? "team" : null;

  if (!scope) {
    throw new Error("syncTasks requires either listId or teamId");
  }

  const scopeId = (opts.listId ?? opts.teamId) as string;
  const scopeKey = `${scope}:${scopeId}`;
  const fetchPage = opts.fetchPage ?? createFetchPage(opts.client);

  const previous = getSyncState(db, scopeKey);
  // A delta sweep must never be treated as a complete view of the list.
  const isFullSweep = opts.full === true || !previous || previous.watermark === 0;
  const watermark = opts.full ? 0 : previous?.watermark ?? 0;

  // Captured before any write: anything older than this was not seen in the
  // current sweep, and can be tombstoned once the sweep is known complete.
  const sweepStartedAt = nextSweepStamp();

  const seenLists = new Set<string>();
  if (scope === "list") {
    seenLists.add(scopeId);
  } else {
    // Team sweeps must also consider lists that returned zero tasks (otherwise
    // removals in a fully emptied list would never be tombstoned). Registration
    // is the only reliable signal for lists not seen in this sweep; unregistered
    // lists stay untouched, which is the safe direction.
    for (const listId of listIdsForTeam(db, scopeId)) seenLists.add(listId);
  }

  let synced = 0;
  let pages = 0;
  let complete = false;
  let maxUpdated = watermark;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await fetchPage({ scope, id: scopeId, page, watermark });
      pages += 1;

      if (batch.length === 0) {
        complete = true;
        break;
      }

      const rows = batch.map(normalizeTask);
      // Every row touched by this sweep shares the sweep stamp, so tombstoning
      // can tell "seen now" from "left over from an earlier sweep".
      for (const row of rows) row.synced_at = sweepStartedAt;

      // One transaction per page keeps the cache consistent without holding a
      // write lock across network calls.
      for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
        upsertMany(db, rows.slice(offset, offset + PAGE_SIZE));
      }

      synced += rows.length;
      for (const row of rows) {
        if (row.list_id) seenLists.add(row.list_id);
        if (row.date_updated !== null && row.date_updated > maxUpdated) {
          maxUpdated = row.date_updated;
        }
      }

      if (batch.length < PAGE_SIZE) {
        complete = true;
        break;
      }
    }
  } catch (error) {
    // Network/API failure: no tombstones, watermark unchanged. A failed sweep
    // must never look like "everything was deleted upstream".
    setSyncState(db, scopeKey, {
      last_sync: Date.now(),
      last_status: "failed",
      task_count: synced,
    });
    return {
      synced,
      pages,
      archived: 0,
      status: "failed",
      durationMs: Date.now() - startedAt,
      watermark,
    };
  }

  let archived = 0;
  // Archiving is only sound on a COMPLETE sweep that saw the whole list. A
  // delta sweep (watermark > 0) only returns recently updated tasks, so running
  // archiveMissing there would tombstone every untouched task.
  if (complete && isFullSweep) {
    for (const listId of seenLists) {
      archived += archiveMissing(db, listId, sweepStartedAt);
    }
  }

  // Only a complete sweep may move the delta cursor forward; otherwise the next
  // delta sweep would start past pages that were never fetched.
  const nextWatermark = complete ? Math.max(watermark, maxUpdated) : watermark;
  const status: SyncResult["status"] = complete ? "ok" : "partial";

  setSyncState(db, scopeKey, {
    watermark: nextWatermark,
    last_sync: Date.now(),
    last_status: status,
    task_count: synced,
  });

  return {
    synced,
    pages,
    archived,
    status,
    durationMs: Date.now() - startedAt,
    watermark: nextWatermark,
  };
}
