import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isPersonFilePath, personFileName, personFilePath } from "./person-file-name.js";

const NAMES = ["amy", "a.b_c-d@e.f", "a b/c", "zoë", "..", "x%y", "f.self-edit-hash", "g.self-delete", "tab\there", "!'()*~"];

describe("person file names", () => {
  it("encodes every unsafe character, as the session-start hook does", () => {
    expect(NAMES.slice(0, 8).map(personFileName)).toEqual([
      "amy.md",
      "a.b_c-d@e.f.md",
      "a%20b%2Fc.md",
      "zo%C3%AB.md",
      "...md",
      "x%25y.md",
      "f%2Eself-edit-hash.md",
      "g%2Eself-delete.md",
    ]);
    expect(personFilePath("a b/c")).toBe("~/fleet/people/a%20b%2Fc.md");
  });

  it("matches the hook's own encoding for the name the people list carries", () => {
    const hook = path.resolve(__dirname, "../../../substrate/scripts/person-files.py");
    const out = execFileSync(
      "python3",
      [
        "-c",
        [
          "import importlib.machinery, importlib.util, json, sys",
          "l = importlib.machinery.SourceFileLoader('pf', sys.argv[1])",
          "m = importlib.util.module_from_spec(importlib.util.spec_from_loader('pf', l)); l.exec_module(m)",
          "print(json.dumps([m.person_file_name(u) for u in json.loads(sys.argv[2])]))",
        ].join("\n"),
        hook,
        // The hook reads names off the people list, where they're already one plain line.
        JSON.stringify(NAMES.map((n) => n.replace(/\t/g, " "))),
      ],
      { encoding: "utf-8" },
    );
    expect(NAMES.map(personFileName)).toEqual(JSON.parse(out));
  });

  it("accepts any person file path and nothing outside the people folder", () => {
    for (const n of NAMES) expect(isPersonFilePath(personFilePath(n))).toBe(true);
    expect(isPersonFilePath("~/fleet/people/../host/people.md")).toBe(false);
    expect(isPersonFilePath("~/fleet/people/a/b.md")).toBe(false);
    expect(isPersonFilePath("~/fleet/people/amy.txt")).toBe(false);
    expect(isPersonFilePath("~/.claude/CLAUDE.md")).toBe(false);
    expect(isPersonFilePath("/home/x/fleet/people/amy.md")).toBe(false);
    expect(isPersonFilePath("~/fleet/people/amy.md\n")).toBe(false);
  });
});
