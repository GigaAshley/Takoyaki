/**
 * End to end on a scratch machine: the real front door (fleet-change, listening) and the
 * server's real read-with-version and save-at-its-turn, through this backend's own-machine
 * path. Nothing is written over a file that changed since an editor opened it; a project
 * file's member list stays the machine's; the roles window's one-line edits change only
 * their lines.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  sshLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  databaseLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "file-save-e2e-"));
process.env.HOME_HOST_DIR = home;

const { fileVersion, readForSave, saveFileAtTurn } = await import("./file-save.js");
const { submitFrontDoor } = await import("./front-door.js");

const FC = path.join(__dirname, "..", "..", "..", "substrate", "scripts", "fleet-change");
let listener: ChildProcess;

function write(rel: string, text: string): string {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
const read = (rel: string) => fs.readFileSync(path.join(home, rel), "utf8");
const at = (rel: string, keepMembers = false) => ({ homePath: rel, localPath: path.join(home, rel), keepMembers });

beforeAll(() => {
  fs.mkdirSync(path.join(home, "fleet", ".changes"), { recursive: true });
  // Installed where this backend looks for it on its own machine.
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.copyFileSync(FC, path.join(home, ".local", "bin", "fleet-change"));
  listener = spawn("python3", [FC, "serve"], {
    env: { ...process.env, FLEET_CHANGE_FLEET_DIR: path.join(home, "fleet"), FLEET_CHANGE_POLL_S: "0.02" },
    stdio: "ignore",
  });
});

afterAll(() => {
  listener.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("whole-file saves at the front door", () => {
  const PROJECT = "fleet/projects/garden/project.md";

  it("a project file: the member list changing meanwhile isn't a change, and the machine's list stays", async () => {
    write(PROJECT, "---\ndisplayName: Garden\nmembers:\n  - finch\n---\nOld notes.\n");
    const opened = await readForSave(null, at(PROJECT, true));
    // Agents join while the editor is open.
    write(PROJECT, "---\ndisplayName: Garden\nmembers:\n  - finch\n  - wren\n---\nOld notes.\n");
    const draft = opened.text.replace("Old notes.", "New notes.");
    const saved = await saveFileAtTurn(null, { ...at(PROJECT, true), data: Buffer.from(draft), expect: opened.version });
    expect(saved).toMatchObject({ ok: true });
    expect(read(PROJECT)).toBe("---\ndisplayName: Garden\nmembers:\n  - finch\n  - wren\n---\nNew notes.\n");
    // The answer's version is the file's, as the next read sees it.
    expect((await readForSave(null, at(PROJECT, true))).version).toBe((saved as { version: string }).version);
  }, 30_000);

  it("a project file moved since it was opened: refused, untouched; saving again over that version overwrites on purpose", async () => {
    const opened = await readForSave(null, at(PROJECT, true));
    write(PROJECT, "---\ndisplayName: Garden\nparent: farm\nmembers:\n  - finch\n  - wren\n---\nNew notes.\n");
    const stale = await saveFileAtTurn(null, { ...at(PROJECT, true), data: Buffer.from(opened.text + "More.\n"), expect: opened.version });
    expect(stale).toMatchObject({ ok: false, status: 409, code: "changed" });
    expect(read(PROJECT)).toContain("parent: farm");
    const now = (stale as { version: string }).version;
    expect(now).toBe((await readForSave(null, at(PROJECT, true))).version);
    const again = await saveFileAtTurn(null, { ...at(PROJECT, true), data: Buffer.from(opened.text + "More.\n"), expect: now });
    expect(again).toMatchObject({ ok: true });
    expect(read(PROJECT)).toBe("---\ndisplayName: Garden\nmembers:\n  - finch\n  - wren\n---\nNew notes.\nMore.\n");
  }, 30_000);

  it("an agent writing in its own file meanwhile: the user's stale save is refused and the agent's words stay", async () => {
    const AGENT = "fleet/identities/finch/finch.md";
    write(AGENT, "---\nroles: []\ntask: \"Gardening\"\n---\n\n# Finch\n");
    const opened = await readForSave(null, at(AGENT));
    fs.appendFileSync(path.join(home, AGENT), "\n## Where things stand\nHalf done.\n");
    const stale = await saveFileAtTurn(null, { ...at(AGENT), data: Buffer.from(opened.text + "\nThe user's line.\n"), expect: opened.version });
    expect(stale).toMatchObject({ ok: false, code: "changed" });
    expect(read(AGENT)).toContain("Half done.");
    expect(read(AGENT)).not.toContain("The user's line.");
  }, 30_000);

  it("a new file: made only while there's none of that name", async () => {
    const NEW = "fleet/identities/finch/workspace/new.txt";
    fs.mkdirSync(path.join(home, "fleet/identities/finch/workspace"), { recursive: true });
    expect(await saveFileAtTurn(null, { ...at(NEW), data: Buffer.from("one"), expect: "absent" })).toMatchObject({ ok: true });
    const second = await saveFileAtTurn(null, { ...at(NEW), data: Buffer.from("two"), expect: "absent" });
    expect(second).toMatchObject({ ok: false, code: "exists", version: fileVersion(Buffer.from("one")) });
    expect(read(NEW)).toBe("one");
  }, 30_000);

  it("the roles window's one-line edit changes only its line, read at its turn", async () => {
    const ROLE = "fleet/roles/eng/eng.md";
    write(ROLE, "---\ndisplayName: Engineer\ncolorHue: '200'\n---\n\nAn agent's notes.\n");
    // An agent adds to the role file after the window loaded it; the edit still lands on top.
    fs.appendFileSync(path.join(home, ROLE), "And more since.\n");
    const outcome = await submitFrontDoor(null, "role-edit", { name: "eng", set: { description: "Builds: things", colorHue: 40 } });
    expect(outcome.state).toBe("done");
    expect(read(ROLE)).toBe(
      "---\ndisplayName: Engineer\ndescription: \"Builds: things\"\ncolorHue: '40'\n---\n\nAn agent's notes.\nAnd more since.\n",
    );
    const markdown = (outcome as { result: { markdown: string } }).result.markdown;
    expect(markdown).toBe(read(ROLE));
    // The version the window gets with it is the file's.
    expect(fileVersion(Buffer.from(markdown))).toBe((await readForSave(null, at(ROLE))).version);
  }, 30_000);
});
