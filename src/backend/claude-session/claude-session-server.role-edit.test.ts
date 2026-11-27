// ─── role:edit WS handler — the roles window's one-line edits ─
//
// Name, description, colour, voice, picture and Borrowable change only their own lines of
// the role file, at the machine's front door (read at their turn), never by writing back
// the copy of the file the window loaded.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ssh/ssh-one-shot.js", () => ({ connectOneShot: vi.fn() }));
vi.mock("../ssh/host-resolver.js", () => ({ resolveHostById: vi.fn() }));
vi.mock("./identity-artifact-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./identity-artifact-reader.js")>()),
  isLocalHostId: vi.fn((id: number | undefined) => id === 6),
}));
vi.mock("../fleet-change/front-door.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fleet-change/front-door.js")>()),
  submitFrontDoor: vi.fn(),
}));
vi.mock("../instance-wide/role-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../instance-wide/role-guard.js")>()),
  checkInstanceWideRoleWrite: vi.fn(async () => ({ verdict: "allow" })),
}));

import { connectOneShot } from "../ssh/ssh-one-shot.js";
import { resolveHostById } from "../ssh/host-resolver.js";
import { submitFrontDoor } from "../fleet-change/front-door.js";
import { fileVersion } from "../fleet-change/file-save.js";
import { checkInstanceWideRoleWrite } from "../instance-wide/role-guard.js";
import { handleRoleEdit } from "./claude-session-server.js";

let sent: Array<Record<string, unknown>>;
const ws = { send: vi.fn((raw: string) => sent.push(JSON.parse(raw))) } as unknown as import("ws").WebSocket;

beforeEach(() => {
  sent = [];
  vi.clearAllMocks();
});

describe("role:edit", () => {
  it("sends just the lines to the front door; answers the file as it now is, with its version", async () => {
    const markdown = "---\ndisplayName: Engineer\ncolorHue: '40'\n---\nAn agent's notes.\n";
    vi.mocked(submitFrontDoor).mockResolvedValue({ state: "done", id: "r", seq: 1, result: { role: "eng", changed: ["colorHue"], markdown } });
    await handleRoleEdit(ws, { type: "role:edit", roleName: "eng", hostId: 6, set: { colorHue: 40 }, unset: ["voice"] }, "u1");
    expect(submitFrontDoor).toHaveBeenCalledWith(null, "role-edit", { name: "eng", set: { colorHue: 40 }, unset: ["voice"] }, { hostId: 6, by: "u1" });
    expect(sent).toEqual([{ type: "role:edited", markdown, version: fileVersion(Buffer.from(markdown)) }]);
  });

  it("a remote machine: over its own connection, closed after", async () => {
    const conn = { end: vi.fn() };
    vi.mocked(resolveHostById).mockResolvedValue({ ip: "1.2.3.4" } as never);
    vi.mocked(connectOneShot).mockResolvedValue(conn as never);
    vi.mocked(submitFrontDoor).mockResolvedValue({ state: "done", id: "r", seq: 1, result: { markdown: "x" } });
    await handleRoleEdit(ws, { type: "role:edit", roleName: "eng", hostId: 3, set: { voice: "alloy" } }, "u1");
    expect(vi.mocked(submitFrontDoor).mock.calls[0][0]).toBe(conn);
    expect(conn.end).toHaveBeenCalled();
  });

  it("a refusal (it's being archived) comes back with its reason and code", async () => {
    vi.mocked(submitFrontDoor).mockResolvedValue({ state: "refused", id: "r", seq: 1, code: "being_archived", reason: "it's being archived" });
    await handleRoleEdit(ws, { type: "role:edit", roleName: "eng", hostId: 6, set: { colorHue: 1 } }, "u1");
    expect(sent).toEqual([{ type: "role:edited", markdown: "", error: "it's being archived", code: "being_archived" }]);
  });

  it("a shared role a non-admin can't change is refused before the machine is asked", async () => {
    vi.mocked(checkInstanceWideRoleWrite).mockResolvedValueOnce({ verdict: "refuse" } as never);
    await handleRoleEdit(ws, { type: "role:edit", roleName: "eng", hostId: 6, set: { colorHue: 1 } }, "u1");
    expect(submitFrontDoor).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ type: "role:edited", code: "instance_wide" });
  });

  it("a bad role name or shape is refused before the machine is asked", async () => {
    await handleRoleEdit(ws, { type: "role:edit", roleName: "../x", hostId: 6, set: {} }, "u1");
    await handleRoleEdit(ws, { type: "role:edit", roleName: "eng", hostId: 6, set: [] }, "u1");
    expect(submitFrontDoor).not.toHaveBeenCalled();
    expect(sent.map((r) => r.code)).toEqual(["bad_request", "bad_request"]);
  });
});
