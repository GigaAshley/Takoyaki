// ─── role:update-file WS handler — the role file editor's Save ─
//
// Keyed directly on roleName (the roles window has no identity context). A save is written
// at its turn at the machine's front door, only over the version the editor opened; then
// the file is read back (with its new version) so the editor rehydrates from the machine.
//
// Test strategy:
//   - vi.mock the front-door save and the exact-bytes reader (file-save.js) so we control
//     the machine's answers.
//   - vi.mock connectOneShot + resolveHostById so we steer LOCAL vs REMOTE routing without
//     a real ssh2 pair.
//   - Drive the handler via the exported __handleRoleUpdateFileForTests seam and assert on
//     the outbound wire messages captured by the wsStub.send spy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../ssh/ssh-one-shot.js", () => ({
  connectOneShot: vi.fn(),
}));
vi.mock("../ssh/host-resolver.js", () => ({
  resolveHostById: vi.fn(),
}));
vi.mock("./identity-artifact-reader.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./identity-artifact-reader.js")
  >();
  return {
    ...actual,
    // Host 6 stands in for the co-located box (IDENTITIES_LOCAL_HOST_IDS).
    isLocalHostId: vi.fn((id: number | undefined) => id === 6),
  };
});
vi.mock("../fleet-change/file-save.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fleet-change/file-save.js")>()),
  readForSave: vi.fn(),
  saveFileAtTurn: vi.fn(),
}));

import { connectOneShot } from "../ssh/ssh-one-shot.js";
import { resolveHostById } from "../ssh/host-resolver.js";
import { readForSave, saveFileAtTurn } from "../fleet-change/file-save.js";
import { __handleRoleUpdateFileForTests } from "./claude-session-server.js";

type RoleFileUpdatedEvent = {
  type: "role:file-updated";
  markdown: string;
  error?: string;
  code?: string;
  version?: string | null;
};

const OPENED = "a".repeat(64);
const NOW = "b".repeat(64);

function makeFakeConn(label: string): { end: () => void; __label: string } {
  return { end: vi.fn(), __label: label };
}

let sent: RoleFileUpdatedEvent[];
const wsStub = {
  send: vi.fn((raw: string) => {
    sent.push(JSON.parse(raw) as RoleFileUpdatedEvent);
  }),
};
const ws = wsStub as unknown as import("ws").WebSocket;

function readsBack(markdown: string): void {
  vi.mocked(readForSave).mockResolvedValue({ data: Buffer.from(markdown), text: markdown, version: NOW });
}

beforeEach(() => {
  sent = [];
  wsStub.send.mockClear();
  vi.mocked(connectOneShot).mockReset();
  vi.mocked(resolveHostById).mockReset();
  vi.mocked(readForSave).mockReset();
  vi.mocked(saveFileAtTurn).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("role:update-file WS handler — saving", () => {
  it("LOCAL: saved at the front door over the version opened, then read back with its new version", async () => {
    vi.mocked(saveFileAtTurn).mockResolvedValue({ ok: true, version: NOW, requestId: "r" });
    readsBack("---\ntitle: Skynet\n---\n\nbody");

    await __handleRoleUpdateFileForTests(
      ws,
      { type: "role:update-file", roleName: "box-maintainer", contents: "---\ntitle: Skynet\n---\n\nbody", hostId: 6, version: OPENED },
      "1",
    );

    expect(saveFileAtTurn).toHaveBeenCalledTimes(1);
    const [conn, opts] = vi.mocked(saveFileAtTurn).mock.calls[0];
    expect(conn).toBeNull();
    expect(opts).toMatchObject({ homePath: "fleet/roles/box-maintainer/box-maintainer.md", expect: OPENED, hostId: 6, by: "1" });
    expect(opts.data.toString()).toBe("---\ntitle: Skynet\n---\n\nbody");
    expect(sent).toEqual([{ type: "role:file-updated", markdown: "---\ntitle: Skynet\n---\n\nbody", version: NOW }]);
    expect(connectOneShot).not.toHaveBeenCalled();
  });

  it("REMOTE: resolves the host, saves and reads with the connection, closes it", async () => {
    const fakeConn = makeFakeConn("hostX");
    vi.mocked(resolveHostById).mockResolvedValue({ ip: "1.2.3.4", username: "ubuntu" } as never);
    vi.mocked(connectOneShot).mockResolvedValue(fakeConn as never);
    vi.mocked(saveFileAtTurn).mockResolvedValue({ ok: true, version: NOW, requestId: "r" });
    readsBack("role body\n");

    await __handleRoleUpdateFileForTests(ws, { type: "role:update-file", roleName: "box-maintainer", hostId: 3, contents: "role body\n", version: OPENED }, "1");

    expect(vi.mocked(saveFileAtTurn).mock.calls[0][0]).toBe(fakeConn);
    expect(vi.mocked(readForSave).mock.calls[0][0]).toBe(fakeConn);
    expect(fakeConn.end).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({ type: "role:file-updated", markdown: "role body\n", version: NOW });
  });

  it("changed since it was opened (an agent wrote in it): nothing read back, the refusal carries the version now", async () => {
    vi.mocked(saveFileAtTurn).mockResolvedValue({ ok: false, status: 409, code: "changed", error: "it changed since you opened it", version: NOW });

    await __handleRoleUpdateFileForTests(ws, { type: "role:update-file", roleName: "box-maintainer", hostId: 6, contents: "stale", version: OPENED }, "1");

    expect(readForSave).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: "role:file-updated", markdown: "", error: "it changed since you opened it", code: "changed", version: NOW }]);
  });
});

describe("role:update-file WS handler — refused before touching the machine", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["an invalid roleName", { roleName: "../evil", contents: "x", hostId: 6, version: OPENED }, "invalid roleName"],
    ["contents that aren't a string", { roleName: "box-maintainer", contents: 42, hostId: 6, version: OPENED }, "contents must be a string"],
    ["no version", { roleName: "box-maintainer", contents: "x", hostId: 6 }, "version is required — the one the file was opened at"],
    ["a made-up version", { roleName: "box-maintainer", contents: "x", hostId: 6, version: "nope" }, "version is required — the one the file was opened at"],
  ];
  for (const [label, body, error] of cases) {
    it(label, async () => {
      await __handleRoleUpdateFileForTests(ws, { type: "role:update-file", ...body }, "1");
      expect(saveFileAtTurn).not.toHaveBeenCalled();
      expect(connectOneShot).not.toHaveBeenCalled();
      expect(sent[0]).toMatchObject({ type: "role:file-updated", markdown: "", error });
    });
  }

  it("a host that isn't found", async () => {
    vi.mocked(resolveHostById).mockResolvedValue(null as never);
    await __handleRoleUpdateFileForTests(ws, { type: "role:update-file", roleName: "box-maintainer", hostId: 999, contents: "body", version: OPENED }, "1");
    expect(saveFileAtTurn).not.toHaveBeenCalled();
    expect(sent[0]).toEqual({ type: "role:file-updated", markdown: "", error: "host not found" });
  });

  it("an oversized file", async () => {
    await __handleRoleUpdateFileForTests(
      ws,
      { type: "role:update-file", roleName: "box-maintainer", hostId: 6, contents: "x".repeat(2_000_001), version: OPENED },
      "1",
    );
    expect(saveFileAtTurn).not.toHaveBeenCalled();
    expect(sent[0].error).toContain("IDMEDIT_MAX_MARKDOWN_BYTES");
  });

  for (const [label, hostId] of [
    ["omitted", undefined],
    ["null", null],
    ["zero", 0],
    ["string", "6"],
    ["fractional", 6.5],
  ] as const) {
    it(`a hostId that's ${label}: {error:'hostId is required'}`, async () => {
      await __handleRoleUpdateFileForTests(
        ws,
        { type: "role:update-file", roleName: "box-maintainer", contents: "x", version: OPENED, ...(hostId === undefined ? {} : { hostId }) },
        "1",
      );
      expect(saveFileAtTurn).not.toHaveBeenCalled();
      expect(resolveHostById).not.toHaveBeenCalled();
      expect(sent).toEqual([{ type: "role:file-updated", markdown: "", error: "hostId is required" }]);
    });
  }
});
