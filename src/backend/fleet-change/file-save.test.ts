/**
 * file-save.test.ts — a file's version is reckoned here exactly as the machine reckons it
 * (the save is checked there against the version the editor was given here), and the
 * answers a save can get.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  sshLogger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
const submit = vi.fn();
vi.mock("./front-door.js", async (orig) => ({
  ...(await orig<typeof import("./front-door.js")>()),
  submitFrontDoor: (...a: unknown[]) => submit(...a),
}));
const exec = vi.fn(async () => "");
vi.mock("../ssh/tmux-helper.js", () => ({ execCommand: (...a: unknown[]) => exec(...(a as [])) }));
const writes: string[] = [];
vi.mock("../claude-session/identity-artifact-reader.js", () => ({
  getLocalIdentitiesRoot: () => "/nowhere/fleet/identities",
  writeBinaryFileAtomic: async (_c: unknown, p: string) => {
    writes.push(p);
  },
}));

import { fileVersion, saveFileAtTurn, withoutFrontmatterKey } from "./file-save.js";

const FC = path.join(__dirname, "..", "..", "..", "substrate", "scripts", "fleet-change");

function machineVersions(texts: string[], keep: boolean): string[] {
  const py = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("fc", sys.argv[1])
spec = importlib.util.spec_from_loader("fc", loader)
fc = importlib.util.module_from_spec(spec); loader.exec_module(fc)
for t in json.loads(sys.stdin.read()):
    print(fc.file_version(t.encode("utf-8"), sys.argv[2] == "1"))
`;
  return execFileSync("python3", ["-c", py, FC, keep ? "1" : "0"], { input: JSON.stringify(texts), encoding: "utf8" })
    .trim()
    .split("\n");
}

const SAMPLES = [
  "",
  "no frontmatter\n",
  "---\ndisplayName: Garden\nmembers:\n  - finch\n  - wren\n---\nNotes.\n",
  "---\ndisplayName: Garden\nmembers: [finch, wren]\nparent: farm\n---\n",
  "---\nmembers:\n- finch\n\n- wren\nusers:\n  - ann\n---\nbody\n",
  "﻿---\r\ndisplayName: G\r\nmembers:\r\n  - a\r\n---\r\nwin\r\n",
  "---\ndisplayName: G\nmembersExtra: x\n---\n",
  "---\ndisplayName: G\nmembers:  # auto-maintained\n  - finch\n---\n",
  "---\nunclosed\nmembers:\n  - x\n",
];

describe("a file's version", () => {
  it("agrees with the machine's, with and without the member list", () => {
    expect(SAMPLES.map((t) => fileVersion(Buffer.from(t, "utf8"), true))).toEqual(machineVersions(SAMPLES, true));
    expect(SAMPLES.map((t) => fileVersion(Buffer.from(t, "utf8")))).toEqual(machineVersions(SAMPLES, false));
  });

  it("a project file's member list changing isn't a change; anything else is", () => {
    const a = "---\ndisplayName: Garden\nmembers:\n  - finch\n---\nNotes.\n";
    const b = "---\ndisplayName: Garden\nmembers:\n  - finch\n  - wren\n---\nNotes.\n";
    const c = "---\ndisplayName: Garden\nparent: farm\nmembers:\n  - finch\n---\nNotes.\n";
    const v = (t: string) => fileVersion(Buffer.from(t), true);
    expect(v(a)).toBe(v(b));
    expect(v(a)).not.toBe(v(c));
    expect(withoutFrontmatterKey(b, "members")).toBe("---\ndisplayName: Garden\n---\nNotes.\n");
  });
});

describe("saving at the front door", () => {
  beforeEach(() => {
    submit.mockReset();
    exec.mockClear();
    writes.length = 0;
  });
  const conn = {} as never;
  const save = (expect = "a".repeat(64)) =>
    saveFileAtTurn(conn, { homePath: "fleet/projects/garden/project.md", data: Buffer.from("x"), expect, keepMembers: true, hostId: 3, by: "u1", requestId: "r1" });

  it("stages the contents, then asks the machine to write them over the version opened", async () => {
    submit.mockResolvedValue({ state: "done", id: "r1", seq: 1, result: { version: "b".repeat(64) } });
    expect(await save()).toEqual({ ok: true, version: "b".repeat(64), requestId: "r1" });
    expect(writes).toEqual(["$HOME/fleet/.changes/uploads/save-r1"]);
    expect(submit).toHaveBeenCalledWith(
      conn,
      "file-save",
      { path: "fleet/projects/garden/project.md", upload: "save-r1", expect: "a".repeat(64), keepMembers: true },
      { id: "r1", hostId: 3, by: "u1" },
    );
  });

  it("changed since: refused with the version there now", async () => {
    submit.mockResolvedValue({ state: "refused", id: "r1", seq: 1, code: "changed", reason: "it changed since you opened it", result: { version: "c".repeat(64) } });
    expect(await save()).toMatchObject({ ok: false, status: 409, code: "changed", version: "c".repeat(64) });
    submit.mockResolvedValue({ state: "refused", id: "r1", seq: 1, code: "changed", reason: "gone", result: { version: null } });
    expect(await save()).toMatchObject({ ok: false, code: "changed", version: null });
  });

  it("refuses a made-up version before touching the machine", async () => {
    expect(await save("nope")).toMatchObject({ ok: false, status: 400 });
    expect(submit).not.toHaveBeenCalled();
  });

  it("a machine not updated yet: the staged copy is taken away again", async () => {
    submit.mockResolvedValue({ state: "not_installed", id: "r1" });
    expect(await save()).toMatchObject({ ok: false, status: 503 });
    expect(exec).toHaveBeenLastCalledWith(conn, 'rm -f "$HOME/fleet/.changes/uploads/save-r1"');
  });

  it("still waiting its turn: says so, never claims it was saved", async () => {
    submit.mockResolvedValue({ state: "pending", id: "r1", seq: 1, stage: "queued" });
    expect(await save()).toMatchObject({ ok: false, status: 202, code: "pending" });
  });
});
