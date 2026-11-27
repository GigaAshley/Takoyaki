/**
 * front-door.ts — send a change to a machine's front door (fleet-change) and
 * wait for its outcome.
 *
 * Every change to projects and apps on a machine is a request to fleet-change
 * (substrate/scripts/fleet-change): written down, numbered in arrival order
 * and carried out one at a time by the machine's listener. A remote machine is
 * reached with the short command over the SSH connection the route already
 * holds; this backend's own machine through the bind mount, with the same
 * on-disk protocol the command uses (~/fleet/.changes/).
 *
 * The caller chooses the request id, so sending the same request again (a
 * retried click) never does it twice. The wait is bounded (FRONT_DOOR_WAIT_S);
 * a request still waiting or running after it comes back as "pending" with
 * its id, and the machine carries on with it regardless.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Client as SSHClientType } from "ssh2";
import { execCommand } from "../ssh/tmux-helper.js";
import { databaseLogger } from "../utils/logger.js";

/** How long a click waits for the machine's answer before "still working on it". */
export const FRONT_DOOR_WAIT_S = 15;
/** Extra time the SSH exec is given beyond the wait, for the command itself. */
const EXEC_GRACE_MS = 10_000;
const LOCAL_POLL_MS = 100;

export type FrontDoorKind = "app-move" | "project-contents" | "project-archive";

export type FrontDoorOutcome =
  | { state: "done"; id: string; seq: number | null; result: unknown }
  | { state: "refused" | "failed"; id: string; seq: number | null; code: string; reason: string; result?: unknown }
  | { state: "pending"; id: string; seq: number | null; stage: "received" | "queued" | "running" }
  /** fleet-change isn't on the machine yet: its update after a deploy hasn't finished. */
  | { state: "not_installed"; id: string };

export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** A caller-supplied request id when it's usable, else a fresh one. */
export function requestIdFrom(raw: unknown): string {
  return typeof raw === "string" && REQUEST_ID_RE.test(raw) ? raw : randomUUID();
}

function shellWord(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Turn fleet-change's one-line answer into an outcome. */
export function parseFrontDoorLine(id: string, line: string): FrontDoorOutcome {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`unreadable answer from the machine's front door: ${line.slice(0, 200)}`);
  }
  const seq = typeof raw.seq === "number" ? raw.seq : null;
  switch (raw.state) {
    case "done":
      return { state: "done", id, seq, result: raw.result ?? null };
    case "refused":
    case "failed":
      return {
        state: raw.state,
        id,
        seq,
        code: typeof raw.code === "string" ? raw.code : "unknown",
        reason: typeof raw.reason === "string" ? raw.reason : "the machine didn't say why",
        ...(raw.result !== undefined ? { result: raw.result } : {}),
      };
    case "received":
    case "queued":
    case "running":
      return { state: "pending", id, seq, stage: raw.state };
    case "not_installed":
      return { state: "not_installed", id };
    default:
      // "unknown" right after a submit means the request was never written down.
      throw new Error(`the machine's front door lost the request (${String(raw.state)})`);
  }
}

/**
 * Send one request to the machine's front door and wait (up to `waitS`) for
 * its outcome. `conn` null = this backend's own machine (bind mount).
 */
export async function submitFrontDoor(
  conn: SSHClientType | null,
  kind: FrontDoorKind,
  args: Record<string, unknown>,
  opts: { id?: string; waitS?: number; hostId?: number } = {},
): Promise<FrontDoorOutcome> {
  const id = opts.id ?? randomUUID();
  if (!REQUEST_ID_RE.test(id)) throw new Error("invalid request id");
  const waitS = opts.waitS ?? FRONT_DOOR_WAIT_S;
  const t0 = Date.now();
  const outcome = conn === null
    ? await submitLocally(kind, args, id, waitS)
    : await submitOverSsh(conn, kind, args, id, waitS);
  databaseLogger.info("front door request", {
    operation: "front_door_request",
    hostId: opts.hostId,
    kind,
    requestId: id,
    seq: "seq" in outcome ? outcome.seq : null,
    state: outcome.state,
    code: "code" in outcome ? outcome.code : undefined,
    ms: Date.now() - t0,
  });
  return outcome;
}

async function submitOverSsh(
  conn: SSHClientType,
  kind: FrontDoorKind,
  args: Record<string, unknown>,
  id: string,
  waitS: number,
): Promise<FrontDoorOutcome> {
  const fc = '"$HOME/.local/bin/fleet-change"';
  const cmd =
    `if [ -f ${fc} ]; then python3 ${fc} submit ${kind} ${shellWord(JSON.stringify(args))} ` +
    `--id ${shellWord(id)} --wait ${waitS}; else echo '{"state":"not_installed"}'; fi`;
  const out = await execCommand(conn, cmd, { timeoutMs: waitS * 1000 + EXEC_GRACE_MS });
  const line = out.trim().split("\n").pop() ?? "";
  return parseFrontDoorLine(id, line);
}

// ---------------------------------------------------------------------------
// This backend's own machine: the same protocol as `fleet-change submit`,
// through the bind mount.
// ---------------------------------------------------------------------------

function localHome(): string {
  return process.env.HOME_HOST_DIR || process.env.HOME || "/";
}

function changesRoot(): string {
  return process.env.FLEET_CHANGES_DIR || path.join(localHome(), "fleet", ".changes");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith(".json") && !n.includes(".tmp.")).sort();
  } catch {
    return [];
  }
}

function idOf(name: string): string | null {
  const i = name.indexOf("-");
  return i < 0 ? null : name.slice(i + 1, -".json".length);
}

/** Where a request is: its outcome line, or how far it has got, or null when unseen. */
async function whereIs(id: string): Promise<string | null> {
  const root = changesRoot();
  try {
    return await fs.readFile(path.join(root, "outcomes", `${id}.json`), "utf8");
  } catch {
    /* not finished */
  }
  for (const name of await listJson(path.join(root, "journal"))) {
    if (idOf(name) !== id) continue;
    try {
      const entry = JSON.parse(await fs.readFile(path.join(root, "journal", name), "utf8")) as { state?: string; seq?: number };
      return JSON.stringify({ id, seq: entry.seq ?? null, state: entry.state === "running" ? "running" : "queued" });
    } catch {
      return JSON.stringify({ id, state: "queued" });
    }
  }
  for (const name of await listJson(path.join(root, "incoming"))) {
    if (idOf(name) === id) return JSON.stringify({ id, state: "received" });
  }
  return null;
}

async function submitLocally(
  kind: FrontDoorKind,
  args: Record<string, unknown>,
  id: string,
  waitS: number,
): Promise<FrontDoorOutcome> {
  if (!(await exists(path.join(localHome(), ".local", "bin", "fleet-change")))) {
    return { state: "not_installed", id };
  }
  const incoming = path.join(changesRoot(), "incoming");
  if ((await whereIs(id)) === null) {
    await fs.mkdir(incoming, { recursive: true });
    // Same name shape as fleet-change submit: arrival time in ns, then the id.
    const name = `${(BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n).toString().padStart(20, "0")}-${id}.json`;
    const tmp = path.join(incoming, `${name}.tmp.${process.pid}`);
    await fs.writeFile(tmp, JSON.stringify({ id, kind, args, received_at: Date.now() / 1000 }) + "\n");
    await fs.rename(tmp, path.join(incoming, name));
  }
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    const line = await whereIs(id);
    if (line !== null) {
      const outcome = parseFrontDoorLine(id, line);
      if (outcome.state !== "pending" || Date.now() >= deadline) return outcome;
    } else if (Date.now() >= deadline) {
      return parseFrontDoorLine(id, JSON.stringify({ state: "unknown" }));
    }
    await new Promise((r) => setTimeout(r, LOCAL_POLL_MS));
  }
}

/** The HTTP answer for an outcome a route doesn't treat specially. */
export function frontDoorHttp(outcome: FrontDoorOutcome): { status: number; body: Record<string, unknown> } {
  switch (outcome.state) {
    case "done":
      return { status: 200, body: { ok: true, requestId: outcome.id, result: outcome.result } };
    case "refused":
      return {
        status: 409,
        body: { error: outcome.reason, code: outcome.code, requestId: outcome.id, ...(outcome.result !== undefined ? { result: outcome.result } : {}) },
      };
    case "failed":
      return { status: 500, body: { error: outcome.reason, code: outcome.code, requestId: outcome.id } };
    case "pending":
      return {
        status: 202,
        body: { ok: false, pending: true, requestId: outcome.id, stage: outcome.stage, error: "still working on it" },
      };
    case "not_installed":
      return { status: 503, body: { error: "this machine is still updating, try again in a moment", code: "updating" } };
  }
}
