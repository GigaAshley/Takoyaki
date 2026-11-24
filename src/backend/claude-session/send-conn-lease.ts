/**
 * send-conn-lease.ts — keep a pane's SSH connection open until every send
 * already received on it has been typed.
 *
 * A send into a dormant pane waits for the agent to wake (up to
 * MARKER_FALLBACK_MS) before typing. That work used to die with the browser:
 * closing the app tore the pane down, ended the connection, and the send
 * failed "Not connected" after waiting out the full wake window — the message
 * was lost. Each received send now leases the connection; teardown asks for
 * the connection to end once the leases are all released, so delivery
 * finishes whether or not anyone is still watching.
 *
 * A cap bounds how long teardown waits, so a wedged exec can't hold a
 * connection open forever.
 */

import { sshLogger } from "../utils/logger.js";

/** Longest teardown waits for in-flight sends before ending the conn anyway.
 *  Covers a full wake window plus typing for a few queued sends. */
export const SEND_LEASE_CAP_MS = 5 * 60 * 1000;

interface LeaseState {
  count: number;
  end: (() => void) | null;
  capTimer: NodeJS.Timeout | null;
}

const leases = new Map<object, LeaseState>();

function finish(conn: object, st: LeaseState, why: "idle" | "cap"): void {
  if (st.capTimer) clearTimeout(st.capTimer);
  leases.delete(conn);
  const end = st.end;
  st.end = null;
  if (why === "cap") {
    sshLogger.warn("[send-lease] cap reached with sends still in flight; ending connection", {
      operation: "send_lease_cap_reached",
      inFlight: st.count,
    });
  } else {
    sshLogger.info("[send-lease] in-flight sends delivered; ending deferred connection", {
      operation: "send_lease_deferred_end",
    });
  }
  end?.();
}

/** Mark one send in flight on `conn`. Call the returned function once the
 *  send is done (success or failure); extra calls are ignored. */
export function leaseSendConn(conn: object): () => void {
  let st = leases.get(conn);
  if (!st) {
    st = { count: 0, end: null, capTimer: null };
    leases.set(conn, st);
  }
  st.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = leases.get(conn);
    if (!cur) return;
    cur.count--;
    if (cur.count > 0) return;
    if (cur.end) finish(conn, cur, "idle");
    else leases.delete(conn);
  };
}

/** End `conn` now if no send is in flight on it, otherwise once the last one
 *  is released (or SEND_LEASE_CAP_MS passes). Returns true when deferred. */
export function endConnWhenSendsDone(
  conn: object,
  end: () => void,
  capMs: number = SEND_LEASE_CAP_MS,
): boolean {
  const st = leases.get(conn);
  if (!st || st.count === 0) {
    end();
    return false;
  }
  st.end = end;
  if (!st.capTimer) {
    st.capTimer = setTimeout(() => {
      const cur = leases.get(conn);
      if (cur) finish(conn, cur, "cap");
    }, capMs);
    st.capTimer.unref?.();
  }
  sshLogger.info("[send-lease] pane torn down with sends in flight; keeping connection open until they're delivered", {
    operation: "send_lease_deferred",
    inFlight: st.count,
    capMs,
  });
  return true;
}

export function __resetSendConnLeasesForTests(): void {
  for (const st of leases.values()) if (st.capTimer) clearTimeout(st.capTimer);
  leases.clear();
}
