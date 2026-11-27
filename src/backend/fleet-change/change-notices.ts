/**
 * change-notices.ts — which of a machine's notices each person has already had.
 *
 * A machine keeps a day of notices for the people who asked for its changes: a
 * refusal, a failure, a new agent left out of its project, an archive whose clean-up
 * is stuck (fleet-change; the sweep's `changes` line carries them). A person is told
 * each one once:
 *
 *   - Told directly: the device that clicked got the outcome as its answer (and said
 *     why there and then). Recorded here when the server hands that outcome over, so
 *     no mark or pop-up repeats it.
 *   - Dismissed: the person closed the mark on a row, or one device claimed a pop-up
 *     (the first claim wins, so only one device shows it).
 *
 * While the server is still waiting on a request for someone (`asking`), its notice is
 * held back too: the answer is about to reach the device that asked.
 *
 * Keys are per (user, host): a request id, or `<id>:stuck` for a stuck archive. Kept two
 * days (the machine keeps a notice one).
 */
import type Database from "better-sqlite3";
import { getSqlite } from "../database/db/index.js";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { databaseLogger } from "../utils/logger.js";

export { CHANGE_NOTICE_TABLES_SQL } from "./change-notices-schema.js";

const KEEP_MS = 2 * 24 * 3600 * 1000;
const STUCK_KEEP_MS = 90 * 24 * 3600 * 1000;
const KEY_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export interface ChangeNoticeStore {
  /** Record that the user has had this notice. True when this is the first time. */
  markSeen(userId: string, hostId: string, key: string): boolean;
  isSeen(userId: string, hostId: string, key: string): boolean;
  /** Take a "had it" back (the answer that counted as telling them never reached them). */
  unmarkSeen(userId: string, hostId: string, key: string): void;
}

export function createChangeNoticeStore(deps: {
  sqlite: () => Database.Database;
  now: () => number;
  save: (reason: string) => Promise<void> | void;
}): ChangeNoticeStore {
  let lastPrune = 0;
  return {
    markSeen(userId, hostId, key) {
      if (!userId || !hostId || !KEY_RE.test(key)) return false;
      const db = deps.sqlite();
      const now = deps.now();
      const changes = db
        .prepare(
          "INSERT OR IGNORE INTO machine_change_notices_seen (user_id, host_id, notice_key, seen_at) VALUES (?, ?, ?, ?)",
        )
        .run(userId, hostId, key, now).changes;
      if (now - lastPrune > 3600 * 1000) {
        lastPrune = now;
        // A stuck archive is reported for as long as it stays stuck — its "had it" is kept
        // much longer, so it never pops up again.
        db.prepare(
          "DELETE FROM machine_change_notices_seen WHERE (notice_key NOT LIKE '%:stuck' AND seen_at < ?) OR seen_at < ?",
        ).run(now - KEEP_MS, now - STUCK_KEEP_MS);
      }
      if (changes > 0) {
        try {
          void Promise.resolve(deps.save("machine-change-notice-seen")).catch(() => undefined);
        } catch {
          /* the row is in memory; the next save carries it */
        }
      }
      return changes > 0;
    },
    unmarkSeen(userId, hostId, key) {
      deps
        .sqlite()
        .prepare("DELETE FROM machine_change_notices_seen WHERE user_id = ? AND host_id = ? AND notice_key = ?")
        .run(userId, hostId, key);
    },
    isSeen(userId, hostId, key) {
      return (
        deps
          .sqlite()
          .prepare("SELECT 1 FROM machine_change_notices_seen WHERE user_id = ? AND host_id = ? AND notice_key = ?")
          .get(userId, hostId, key) !== undefined
      );
    },
  };
}

let singleton: ChangeNoticeStore | null = null;

export function getChangeNoticeStore(): ChangeNoticeStore {
  if (singleton === null) {
    singleton = createChangeNoticeStore({
      sqlite: getSqlite,
      now: () => Date.now(),
      save: (reason) => DatabaseSaveTrigger.triggerSave(reason),
    });
  }
  return singleton;
}

/** Tests: use this store instead. */
export function setChangeNoticeStoreForTests(store: ChangeNoticeStore | null): void {
  singleton = store;
}

// ── Telling open devices what changed ───────────────────────────────────────

let refan: ((hostId: string) => void) | null = null;

/** Set once at boot: send a host's open changes to every device again (their view changed). */
export function setNoticeRefan(fn: ((hostId: string) => void) | null): void {
  refan = fn;
}

function refanHost(hostId: number | string): void {
  try {
    refan?.(String(hostId));
  } catch {
    /* the next change on that machine carries it */
  }
}

/** A person dismissed a notice (or a device claimed its pop-up). True for the first claim. */
export function dismissNotice(userId: string, hostId: number | string, key: string): boolean {
  const first = getChangeNoticeStore().markSeen(userId, String(hostId), key);
  if (first) refanHost(hostId);
  return first;
}

// ── Requests the server is waiting on right now ─────────────────────────────

const asking = new Map<string, number>();
const askKey = (hostId: number | string, id: string) => `${hostId}:${id}`;

/** The server is waiting on this request for someone; call the returned function when done. */
export function beginAsking(hostId: number | string, id: string): () => void {
  const k = askKey(hostId, id);
  asking.set(k, (asking.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (asking.get(k) ?? 1) - 1;
    if (n <= 0) {
      asking.delete(k);
      // A notice held back while this was being waited on may be due now (the wait ended
      // without an answer reaching them).
      refanHost(hostId);
    } else asking.set(k, n);
  };
}

export function isBeingAsked(hostId: number | string, id: string): boolean {
  return asking.has(askKey(hostId, id));
}

/**
 * The outcome went back to the person who asked as their answer: they've been told, so
 * the machine's notice for it (a refusal, a failure, a new agent left out of its project)
 * is never shown to them again.
 */
export function toldDirectly(
  userId: string | undefined,
  hostId: number | undefined,
  outcome: { state: string; id: string; result?: unknown },
): void {
  if (!userId || hostId === undefined) return;
  if (!isNoticeOutcome(outcome)) return;
  try {
    getChangeNoticeStore().markSeen(userId, String(hostId), outcome.id);
  } catch (err) {
    databaseLogger.warn("couldn't record a machine notice as told", {
      operation: "machine_change_notice_told_failed",
      hostId,
      requestId: outcome.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * An outcome that counted as telling the asker (toldDirectly) is only told once its answer
 * actually reaches them: if the connection closes before the response was sent, the "had it"
 * is taken back, so the notice shows on their devices after all.
 */
export function untellIfUndelivered(
  res: { on(event: "close", fn: () => void): unknown; writableFinished: boolean },
  userId: string | undefined,
  hostId: number | undefined,
  outcome: { state: string; id: string; result?: unknown },
): void {
  if (!userId || hostId === undefined || !isNoticeOutcome(outcome)) return;
  res.on("close", () => {
    if (res.writableFinished) return;
    try {
      getChangeNoticeStore().unmarkSeen(userId, String(hostId), outcome.id);
      databaseLogger.info("machine notice answer not delivered — the asker will see it on the row", {
        operation: "machine_change_notice_undelivered",
        hostId,
        requestId: outcome.id,
      });
      refanHost(hostId);
    } catch {
      /* the notice then stays counted as told */
    }
  });
}

function isNoticeOutcome(outcome: { state: string; result?: unknown }): boolean {
  const notFiled = (outcome.result as { notFiled?: unknown } | null | undefined)?.notFiled;
  return outcome.state === "refused" || outcome.state === "failed" || (outcome.state === "done" && typeof notFiled === "string");
}
