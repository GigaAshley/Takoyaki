/**
 * fleet-status-sweep.py's JSONL tail reads: the full tail, or only the whole
 * lines appended since the caller's known position (`--known-tails`). Runs
 * the script's own helpers under python3 against scratch files.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const sweep = join(__dirname, "..", "..", "..", "substrate", "scripts", "fleet-status-sweep.py");

type Tail = { text: string; file: string; end: number; base: number | null } | null;

/** Call one of the sweep's helpers with JSON args and get its JSON result. */
function py(fn: string, ...args: unknown[]): unknown {
  const code = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('sweep', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "args = json.loads(sys.argv[2])",
    "if sys.argv[3] == '_read_jsonl_tail' and args[1] is not None: args[1] = tuple(args[1])",
    "r = getattr(m, sys.argv[3])(*args)",
    "if isinstance(r, dict): r = {k: (list(v) if isinstance(v, tuple) else v) for k, v in r.items()}",
    "print(json.dumps(r))",
  ].join("\n");
  const out = execFileSync("python3", ["-I", "-c", code, sweep, JSON.stringify(args), fn], {
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

const readTail = (path: string, known: [string, number] | null) =>
  py("_read_jsonl_tail", path, known) as Tail;

describe("fleet-status-sweep JSONL tail", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sweep-tail-"));
    file = join(dir, "s.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("with nothing known, sends the whole tail up to the last whole line", () => {
    writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":');
    const t = readTail(file, null)!;
    expect(t.text).toBe('{"a":1}\n{"b":2}\n');
    expect(t.base).toBeNull();
    expect(t.end).toBe(16);
    const st = statSync(file, { bigint: true });
    expect(t.file.startsWith(`${st.dev}:${st.ino}:`)).toBe(true);
  });

  it("from a known position, sends only the whole lines appended", () => {
    writeFileSync(file, '{"a":1}\n');
    const first = readTail(file, null)!;
    appendFileSync(file, '{"b":2}\n{"c":');
    const t = readTail(file, [first.file, first.end])!;
    expect(t).toEqual({ text: '{"b":2}\n', file: first.file, end: 16, base: 8 });
  });

  it("nothing appended (or only part of a line) sends an empty delta", () => {
    writeFileSync(file, '{"a":1}\n');
    const first = readTail(file, null)!;
    expect(readTail(file, [first.file, first.end])).toEqual({ text: "", file: first.file, end: 8, base: 8 });
    appendFileSync(file, '{"b":');
    expect(readTail(file, [first.file, first.end])).toEqual({ text: "", file: first.file, end: 8, base: 8 });
  });

  it("a different file, a shrunk file, or a big jump gets the full tail", () => {
    writeFileSync(file, '{"a":1}\n');
    const known = readTail(file, null)!.file;
    expect(readTail(file, [known + "0", 8])!.base).toBeNull();
    expect(readTail(file, [known, 999])!.base).toBeNull();
    const other = join(dir, "other.jsonl");
    writeFileSync(other, '{"a":1}\n{"b":2}\n');
    expect(readTail(other, [known, 8])!.base).toBeNull();
    appendFileSync(file, ("x".repeat(1000) + "\n").repeat(300));
    const t = readTail(file, [known, 8])!;
    expect(t.base).toBeNull();
    expect(t.text.length).toBe(262144);
    expect(t.text.endsWith("x\n")).toBe(true);
    expect(t.end).toBe(statSync(file).size);
  });

  it("a missing file reads as null", () => {
    expect(readTail(join(dir, "nope.jsonl"), null)).toBeNull();
  });

  it("--known-tails parses, and anything malformed means nothing known", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
    expect(py("_parse_known_tails", ["--known-tails", b64({ finch: ["1:7:ab", 4] })])).toEqual({ finch: ["1:7:ab", 4] });
    expect(py("_parse_known_tails", [])).toEqual({});
    expect(py("_parse_known_tails", ["--known-tails"])).toEqual({});
    expect(py("_parse_known_tails", ["--known-tails", "not base64!"])).toEqual({});
    expect(py("_parse_known_tails", ["--known-tails", b64([1, 2])])).toEqual({});
    expect(
      py("_parse_known_tails", ["--known-tails", b64({ a: ["x"], b: [1, 2], c: ["x", true], d: ["x", 4] })]),
    ).toEqual({ d: ["x", 4] });
  });

  it("a run with --known-tails still emits (unknown identities just get full tails)", () => {
    const arg = Buffer.from(JSON.stringify({ ghost: [1, 2] })).toString("base64");
    const out = execFileSync("python3", ["-I", sweep, "--known-tails", arg], {
      encoding: "utf-8",
      env: { HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    for (const line of out.split("\n").filter(Boolean)) {
      expect(JSON.parse(line).schema_version).toBe(1);
    }
  });
});
