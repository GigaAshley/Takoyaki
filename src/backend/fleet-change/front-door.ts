/**
 * front-door.ts — send a change to a machine's front door (fleet-change) and
 * wait for its outcome.
 *
 * Every change to projects, apps, agents and roles on a machine is a request to fleet-change
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

export type FrontDoorKind =
  | "app-move"
  | "project-contents"
  | "project-archive"
  | "agent-archive"
  | "agent-unarchive"
  | "role-contents"
  | "role-archive"
  | "role-unarchive"
  | "app-archive"
  | "app-unarchive";

/** An archive is done once claimed; while the machine is still finishing it, what's left and
 *  (for anything failing 10 minutes or more) why. */
export type FrontDoorFinishing = { pending: string[]; stuck?: Record<string, string> };

export type FrontDoorOutcome =
  | { state: "done"; id: string; seq: number | null; result: unknown; finishing?: FrontDoorFinishing }
  | { state: "refused" | "failed"; id: string; seq: number | null; code: string; reason: string; result?: unknown }
  /** "finishing" = accepted, and being finished in the background (an agent un-archive). */
  | { state: "pending"; id: string; seq: number | null; stage: "received" | "queued" | "running" | "finishing" }
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
    case "done": {
      const f = raw.finishing as FrontDoorFinishing | undefined;
      return { state: "done", id, seq, result: raw.result ?? null, ...(f && Array.isArray(f.pending) ? { finishing: f } : {}) };
    }
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
      return { state: "pending", id, seq, stage: raw.stage === "finishing" ? "finishing" : raw.state };
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
  let out: string;
  try {
    out = await execCommand(conn, cmd, { timeoutMs: waitS * 1000 + EXEC_GRACE_MS });
  } catch (err) {
    // The command ran out of time on a slow connection: the request was most likely written
    // down and will still run, so it's pending — asking by its id finds out.
    if (err instanceof Error && err.name === "ExecTimeoutError") {
      return { state: "pending", id, seq: null, stage: "received" };
    }
    throw err;
  }
  const line = out.trim().split("\n").pop() ?? "";
  return parseFrontDoorLine(id, line);
}

// ---------------------------------------------------------------------------
// This backend's own machine: the same protocol as `fleet-change submit`,
// through the bind mount.
// ---------------------------------------------------------------------------

// Wall-clock nanoseconds that never go backwards within this process: one wall-clock base,
// advanced by the monotonic clock, so two submits in the same millisecond keep their order.
const WALL_BASE_NS = BigInt(Date.now()) * 1_000_000n;
const MONO_BASE_NS = process.hrtime.bigint();
function arrivalNs(): bigint {
  return WALL_BASE_NS + (process.hrtime.bigint() - MONO_BASE_NS);
}

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

/** Of the agents (and role) a done archive claimed, those whose clean-up isn't finished —
 *  as fleet-change status works it out, from the claims in their folders. */
async function localFinishing(outcome: Record<string, unknown>): Promise<FrontDoorFinishing | null> {
  const res = outcome.result as { claimed?: unknown; role?: unknown } | null | undefined;
  if (outcome.state !== "done" || !res || !Array.isArray(res.claimed)) return null;
  const fleet = path.join(localHome(), "fleet");
  const targets: [string, string][] = res.claimed
    .filter((n): n is string => typeof n === "string" && /^[a-z0-9_-]{1,64}$/.test(n))
    .map((n) => [n, path.join(fleet, "identities", n)]);
  if (outcome.kind === "role-archive" && typeof res.role === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(res.role)) {
    targets.push([res.role, path.join(fleet, "roles", res.role)]);
  }
  const pending: string[] = [];
  const stuck: Record<string, string> = {};
  for (const [name, dir] of targets) {
    let claim: string;
    try {
      claim = await fs.readFile(path.join(dir, ".archiving"), "utf8");
    } catch {
      continue;
    }
    pending.push(name);
    try {
      const c = JSON.parse(claim) as { failing_since?: number; last_error?: string };
      if (typeof c.failing_since === "number" && Date.now() / 1000 - c.failing_since >= 600 && c.last_error) {
        stuck[name] = c.last_error;
      }
    } catch {
      /* an empty or unreadable claim still counts as pending */
    }
  }
  if (pending.length === 0) return null;
  return Object.keys(stuck).length > 0 ? { pending, stuck } : { pending };
}

/** Where a request is: its outcome line, or how far it has got, or null when unseen. */
async function whereIs(id: string): Promise<string | null> {
  const root = changesRoot();
  try {
    const line = await fs.readFile(path.join(root, "outcomes", `${id}.json`), "utf8");
    try {
      const outcome = JSON.parse(line) as Record<string, unknown>;
      const finishing = await localFinishing(outcome);
      if (finishing) return JSON.stringify({ ...outcome, finishing });
    } catch {
      /* parseFrontDoorLine reports an unreadable outcome */
    }
    return line;
  } catch {
    /* not finished */
  }
  try {
    const bg = JSON.parse(await fs.readFile(path.join(root, "background", `${id}.json`), "utf8")) as { seq?: number; kind?: string };
    return JSON.stringify({ id, seq: bg.seq ?? null, kind: bg.kind, state: "running", stage: "finishing" });
  } catch {
    /* not handed off */
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
    const name = `${arrivalNs().toString().padStart(20, "0")}-${id}.json`;
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

/**
 * Where an earlier request is now: its outcome, or still pending, waiting up
 * to `waitS` for it to finish. Null when the machine has never heard of it
 * (or has forgotten it — outcomes are kept a week).
 */
export async function frontDoorStatus(
  conn: SSHClientType | null,
  id: string,
  waitS: number = FRONT_DOOR_WAIT_S,
): Promise<FrontDoorOutcome | null> {
  if (!REQUEST_ID_RE.test(id)) throw new Error("invalid request id");
  let line: string | null;
  if (conn === null) {
    const deadline = Date.now() + waitS * 1000;
    for (;;) {
      line = await whereIs(id);
      const finished = line !== null && parseFrontDoorLine(id, line).state !== "pending";
      if (finished || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, LOCAL_POLL_MS));
    }
  } else {
    const fc = '"$HOME/.local/bin/fleet-change"';
    const out = await execCommand(
      conn,
      `if [ -f ${fc} ]; then python3 ${fc} status ${shellWord(id)} --wait ${waitS}; else echo '{"state":"not_installed"}'; fi`,
      { timeoutMs: waitS * 1000 + EXEC_GRACE_MS },
    );
    line = out.trim().split("\n").pop() ?? "";
    if (line.includes('"state":"unknown"')) line = null;
  }
  return line === null ? null : parseFrontDoorLine(id, line);
}

/**
 * Send a request and keep asking about it, by its id, until it's finished or `totalS` has
 * passed (then it comes back pending; the machine carries on with it).
 */
export async function submitAndFollow(
  conn: SSHClientType | null,
  kind: FrontDoorKind,
  args: Record<string, unknown>,
  opts: { id: string; hostId?: number; totalS: number },
): Promise<FrontDoorOutcome> {
  const deadline = Date.now() + opts.totalS * 1000;
  let outcome = await submitFrontDoor(conn, kind, args, {
    id: opts.id,
    hostId: opts.hostId,
    waitS: Math.min(FRONT_DOOR_WAIT_S, opts.totalS),
  });
  while (outcome.state === "pending" && Date.now() < deadline) {
    const waitS = Math.max(1, Math.min(FRONT_DOOR_WAIT_S, Math.ceil((deadline - Date.now()) / 1000)));
    const next = await frontDoorStatus(conn, opts.id, waitS);
    if (next === null) break;
    outcome = next;
  }
  return outcome;
}

/** The HTTP answer for an outcome a route doesn't treat specially. */
export function frontDoorHttp(outcome: FrontDoorOutcome): { status: number; body: Record<string, unknown> } {
  switch (outcome.state) {
    case "done":
      return {
        status: 200,
        body: { ok: true, requestId: outcome.id, result: outcome.result, ...(outcome.finishing ? { finishing: outcome.finishing } : {}) },
      };
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
