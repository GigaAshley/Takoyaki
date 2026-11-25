import { beforeEach, describe, expect, it } from "vitest";
import type { SweepPidLine } from "./sweep-schema.js";
import {
  __resetSweepTailStoreForTests,
  KNOWN_TAILS_ARG_MAX,
  knownTailsArg,
  resolveSweepTails,
  sweepCommand,
  PEER_IDLE_FORGET_MS,
  TAIL_BYTES,
} from "./sweep-tail-store.js";

const PEER = "100.64.0.9:22";
const PLAIN = "~/.local/bin/fleet-status-sweep 2>/dev/null";

function pidLine(
  identity: string,
  tail: string | null,
  pos: { file?: string | null; end?: number | null; base?: number | null } = {},
): SweepPidLine {
  return {
    line_kind: "pid",
    schema_version: 1,
    identity,
    pid: 100,
    session_json: null,
    stat_result: { ok: false, reason: "missing" } as unknown as SweepPidLine["stat_result"],
    per_session_stop_mtime_ms: null,
    activity_mtime_ms: null,
    stopped_mtime_ms: null,
    per_session_stop_payload: null,
    dormant_a: false,
    jsonl_tail: tail,
    ...("file" in pos ? { jsonl_tail_file: pos.file } : {}),
    ...("end" in pos ? { jsonl_tail_end: pos.end } : {}),
    ...("base" in pos ? { jsonl_tail_base: pos.base } : {}),
  };
}

function decodeArg(cmd: string): Record<string, [string, number]> {
  const m = /--known-tails (\S+)/.exec(cmd);
  if (!m) throw new Error(`no --known-tails in ${cmd}`);
  return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
}

describe("sweep-tail-store", () => {
  beforeEach(() => __resetSweepTailStoreForTests());

  it("asks plainly until it holds a tail, then sends what it holds", () => {
    expect(sweepCommand(PEER)).toBe(PLAIN);
    resolveSweepTails(PEER, "r1", [pidLine("finch", "a\nb\n", { file: "f7", end: 4, base: null })]);
    expect(decodeArg(sweepCommand(PEER))).toEqual({ finch: ["f7", 4] });
    expect(sweepCommand(PEER)).toMatch(/ 2>\/dev\/null$/);
  });

  it("splices appended lines onto the held tail", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    const t = resolveSweepTails(PEER, "r2", [pidLine("finch", "two\n", { file: "f7", end: 8, base: 4 })]);
    expect(t.get("finch")).toBe("one\ntwo\n");
    expect(decodeArg(sweepCommand(PEER))).toEqual({ finch: ["f7", 8] });
  });

  it("an empty delta returns the held tail unchanged", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    const t = resolveSweepTails(PEER, "r2", [pidLine("finch", "", { file: "f7", end: 4, base: 4 })]);
    expect(t.get("finch")).toBe("one\n");
  });

  it("keeps the rebuilt tail within the window, counted in bytes", () => {
    const big = "x".repeat(TAIL_BYTES - 2) + "\n";
    resolveSweepTails(PEER, "r1", [pidLine("finch", big, { file: "f1", end: 9000, base: null })]);
    const t = resolveSweepTails(PEER, "r2", [pidLine("finch", "new\n", { file: "f1", end: 9004, base: 9000 })]);
    const tail = t.get("finch")!;
    expect(tail.length).toBe(TAIL_BYTES);
    expect(tail.endsWith("x\nnew\n")).toBe(true);

    const wide = "é".repeat(TAIL_BYTES / 2 - 1) + "\n"; // 2 bytes each
    resolveSweepTails(PEER, "r3", [pidLine("mira", wide, { file: "f2", end: 5, base: null })]);
    const w = resolveSweepTails(PEER, "r4", [
      pidLine("finch", "", { file: "f1", end: 9004, base: 9004 }),
      pidLine("mira", "ééé\n", { file: "f2", end: 12, base: 5 }),
    ]).get("mira")!;
    expect(Buffer.byteLength(w, "utf8")).toBeLessThanOrEqual(TAIL_BYTES);
    expect(w.endsWith("\nééé\n")).toBe(true);
  });

  it("a delta from an offset it doesn't hold resolves to null and keeps what's held", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    const t = resolveSweepTails(PEER, "r2", [pidLine("finch", "two\n", { file: "f7", end: 12, base: 8 })]);
    expect(t.get("finch")).toBeNull();
    expect(decodeArg(sweepCommand(PEER))).toEqual({ finch: ["f7", 4] });
  });

  it("a delta on a different file resolves to null", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    const t = resolveSweepTails(PEER, "r2", [pidLine("finch", "two\n", { file: "f8", end: 8, base: 4 })]);
    expect(t.get("finch")).toBeNull();
  });

  it("a full tail replaces what's held (new file, or the sweep chose to resend)", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    const t = resolveSweepTails(PEER, "r2", [pidLine("finch", "fresh\n", { file: "f8", end: 6, base: null })]);
    expect(t.get("finch")).toBe("fresh\n");
    expect(decodeArg(sweepCommand(PEER))).toEqual({ finch: ["f8", 6] });
  });

  it("resolving the same sweep twice doesn't splice twice", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    const lines = [pidLine("finch", "two\n", { file: "f7", end: 8, base: 4 })];
    const a = resolveSweepTails(PEER, "r2", lines);
    const b = resolveSweepTails(PEER, "r2", lines);
    expect(a.get("finch")).toBe("one\ntwo\n");
    expect(b.get("finch")).toBe("one\ntwo\n");
  });

  it("drops identities whose PID has gone", () => {
    resolveSweepTails(PEER, "r1", [
      pidLine("finch", "one\n", { file: "f7", end: 4, base: null }),
      pidLine("bilbo", "hi\n", { file: "f9", end: 3, base: null }),
    ]);
    resolveSweepTails(PEER, "r2", [pidLine("bilbo", "", { file: "f9", end: 3, base: 3 })]);
    expect(decodeArg(sweepCommand(PEER))).toEqual({ bilbo: ["f9", 3] });
  });

  it("a sweep with no PIDs at all keeps what's held", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    resolveSweepTails(PEER, "r2", []);
    expect(decodeArg(sweepCommand(PEER))).toEqual({ finch: ["f7", 4] });
  });

  it("forgets a peer that hasn't been resolved for a while", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })], 1000);
    resolveSweepTails("100.64.0.10:22", "r1", [], 1000 + PEER_IDLE_FORGET_MS - 1);
    expect(sweepCommand(PEER)).not.toBe(PLAIN);
    resolveSweepTails("100.64.0.10:22", "r2", [], 1000 + PEER_IDLE_FORGET_MS);
    expect(sweepCommand(PEER)).toBe(PLAIN);
  });

  it("several PIDs of one identity resolve once", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    const delta = pidLine("finch", "two\n", { file: "f7", end: 8, base: 4 });
    const t = resolveSweepTails(PEER, "r2", [delta, { ...delta, pid: 101 }]);
    expect(t.get("finch")).toBe("one\ntwo\n");
  });

  it("an older sweep (no positions) passes tails through and holds nothing", () => {
    const t = resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n")]);
    expect(t.get("finch")).toBe("one\n");
    expect(sweepCommand(PEER)).toBe(PLAIN);
  });

  it("a null tail clears what's held", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    const t = resolveSweepTails(PEER, "r2", [pidLine("finch", null)]);
    expect(t.get("finch")).toBeNull();
    expect(sweepCommand(PEER)).toBe(PLAIN);
  });

  it("peers are kept apart, and no peer holds nothing", () => {
    resolveSweepTails(PEER, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    expect(sweepCommand("100.64.0.10:22")).toBe(PLAIN);
    const t = resolveSweepTails(null, "r1", [pidLine("finch", "one\n", { file: "f7", end: 4, base: null })]);
    expect(t.get("finch")).toBe("one\n");
    expect(sweepCommand(null)).toBe(PLAIN);
  });

  it("leaves the argument off when it would be too long", () => {
    const lines: SweepPidLine[] = [];
    for (let i = 0; lines.length * 30 < KNOWN_TAILS_ARG_MAX; i++) {
      lines.push(pidLine(`agent-with-a-long-name-${i}`, "x\n", { file: "f123456789", end: 2, base: null }));
    }
    resolveSweepTails(PEER, "r1", lines);
    expect(knownTailsArg(PEER)).toBeNull();
    expect(sweepCommand(PEER)).toBe(PLAIN);
  });
});
