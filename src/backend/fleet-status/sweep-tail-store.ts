/**
 * sweep-tail-store — keeps each live identity's JSONL tail between sweeps so
 * the sweep only has to send what was appended.
 *
 * Without it every sweep carried the last 256 KB of every live identity's
 * JSONL, changed or not: 17 live agents on one box made each 2 s sweep ~5 MB,
 * which filled that box's upload and starved everything else sharing it
 * (app traffic through Takoyaki included).
 *
 * The caller passes `knownTailsArg(peer)` to the sweep (`--known-tails`),
 * telling it how far into each file it already holds whole lines. The sweep
 * answers with a full tail (jsonl_tail_base absent/null) or just the lines
 * past that point (jsonl_tail_base = the offset it continued from), and
 * `resolveSweepTails` rebuilds the same up-to-256 KB tail the consumers have
 * always read.
 *
 * Module-scope and keyed by peer (`ip:port`), like the sweep-result cache in
 * ssh-poll-orchestrator.ts: every orchestrator polling the same box shares
 * one position per identity, so cached sweep bytes resolve the same way for
 * all of them. A delta whose starting offset doesn't match what's held (two
 * orchestrators raced on the same position) resolves to null for that tick —
 * consumers already treat a null tail as "keep what you had" — and the next
 * sweep is asked from the held position again.
 */
import type { SweepPidLine } from "./sweep-schema.js";

/** Same window as the sweep's TAIL_BYTES — the tail consumers were built for. */
export const TAIL_CHARS = 262144;

/**
 * Above this the known-positions argument is left off and the sweep sends
 * full tails, keeping the exec command well under Linux's 128 KB per-argument
 * limit (~1500 live identities on one box before it kicks in).
 */
export const KNOWN_TAILS_ARG_MAX = 96 * 1024;

interface HeldTail {
  readonly ino: number;
  readonly end: number;
  readonly text: string;
}

const store = new Map<string, Map<string, HeldTail>>();

/** The last raw sweep each peer's tails were resolved from, and the result. */
const lastResolved = new Map<string, { raw: string; tails: Map<string, string | null> }>();

/**
 * base64 of `{identity: [inode, end]}` for every tail held for `peer`, or
 * null when there's nothing held (or it would be too long to pass).
 */
export function knownTailsArg(peer: string | null): string | null {
  if (peer === null) return null;
  const held = store.get(peer);
  if (!held || held.size === 0) return null;
  const known: Record<string, [number, number]> = {};
  for (const [identity, tail] of held) known[identity] = [tail.ino, tail.end];
  const arg = Buffer.from(JSON.stringify(known), "utf8").toString("base64");
  return arg.length > KNOWN_TAILS_ARG_MAX ? null : arg;
}

/** The sweep command, with the known positions when there are any. */
export function sweepCommand(peer: string | null): string {
  const arg = knownTailsArg(peer);
  return arg === null
    ? "~/.local/bin/fleet-status-sweep 2>/dev/null"
    : `~/.local/bin/fleet-status-sweep --known-tails ${arg} 2>/dev/null`;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * identity → the full tail to hand consumers (null = none this tick), for the
 * pid lines of one sweep. Updates what's held for `peer` and drops identities
 * that no longer have a live PID. Resolving the same raw sweep twice (the
 * peer cache hands one sweep to several orchestrators) returns the first
 * result rather than splicing again.
 */
export function resolveSweepTails(
  peer: string | null,
  raw: string,
  pidLines: readonly SweepPidLine[],
): Map<string, string | null> {
  if (peer !== null) {
    const prior = lastResolved.get(peer);
    if (prior && prior.raw === raw) return prior.tails;
  }
  let held = peer !== null ? store.get(peer) : undefined;
  if (peer !== null && !held) {
    held = new Map();
    store.set(peer, held);
  }
  const tails = new Map<string, string | null>();
  for (const line of pidLines) {
    const identity = line.identity;
    if (tails.has(identity)) continue;
    tails.set(identity, resolveOne(held, line));
  }
  if (held) {
    for (const identity of [...held.keys()]) {
      if (!tails.has(identity)) held.delete(identity);
    }
  }
  if (peer !== null) lastResolved.set(peer, { raw, tails });
  return tails;
}

function resolveOne(
  held: Map<string, HeldTail> | undefined,
  line: SweepPidLine,
): string | null {
  const identity = line.identity;
  const text = line.jsonl_tail;
  if (typeof text !== "string") {
    held?.delete(identity);
    return null;
  }
  const ino = line.jsonl_tail_ino;
  const end = line.jsonl_tail_end;
  const base = line.jsonl_tail_base;
  if (!isInt(base)) {
    // Full tail (or an older sweep that doesn't send positions).
    if (isInt(ino) && isInt(end)) held?.set(identity, { ino, end, text });
    else held?.delete(identity);
    return text;
  }
  const prev = held?.get(identity);
  if (!prev || !isInt(ino) || !isInt(end) || prev.ino !== ino || prev.end !== base) {
    return null;
  }
  if (text === "") return prev.text;
  const joined = prev.text + text;
  const trimmed = joined.length > TAIL_CHARS ? joined.slice(-TAIL_CHARS) : joined;
  held!.set(identity, { ino, end, text: trimmed });
  return trimmed;
}

/** TEST-ONLY — clears every held tail. */
export function __resetSweepTailStoreForTests(): void {
  store.clear();
  lastResolved.clear();
}
