import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

// The quick changes — pin, Move to, project create / rename / move, the agent window's
// edits — each go to their machine's front door, in the machine's click order. These tests
// lock each one's request and how the machine's answers come back.

vi.mock("@/main-axios", () => ({
  authApi: { post: vi.fn(), get: vi.fn(), put: vi.fn() },
  handleApiError: (err: unknown, operation: string): never => {
    throw new Error(`${operation}: ${err instanceof Error ? err.message : String(err)}`);
  },
}));

import { authApi } from "@/main-axios";
import { setIdentityPinned } from "@/api/user-preferences-api";
import { setSessionProject } from "@/api/session-project-api";
import { createProject, renameProject, setProjectParent } from "@/api/project-list-api";
import { updateIdentity } from "@/api/identities-api";

function axiosError(status: number, data: unknown): Error {
  const err = new axios.AxiosError("Request failed", "ERR_BAD_RESPONSE");
  err.response = { status, data, statusText: "", headers: {}, config: {} as never };
  return err;
}

beforeEach(() => {
  vi.mocked(authApi.post).mockReset();
  vi.mocked(authApi.get).mockReset();
  vi.mocked(authApi.put).mockReset();
});

describe("setIdentityPinned", () => {
  it("puts the pin with a request id", async () => {
    vi.mocked(authApi.put).mockResolvedValueOnce({ status: 200, data: { ok: true, pinned: true } });
    await setIdentityPinned("wren", 42, true);
    expect(authApi.put).toHaveBeenCalledWith("/identities/wren/pinned", { hostId: 42, pinned: true, requestId: expect.any(String) });
  });

  it("a refusal rejects with the machine's reason", async () => {
    vi.mocked(authApi.put).mockRejectedValueOnce(axiosError(409, { error: "it's being archived", code: "being_archived" }));
    await expect(setIdentityPinned("wren", 42, true)).rejects.toMatchObject({ name: "MachineChangeError", code: "being_archived" });
  });

  it("still waiting: sends the same request again (same id) so the server can tell open tabs", async () => {
    vi.mocked(authApi.put)
      .mockResolvedValueOnce({ status: 202, data: { pending: true, requestId: "p1" } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true } });
    await setIdentityPinned("wren", 42, false);
    expect(vi.mocked(authApi.put).mock.calls[1]).toEqual(["/identities/wren/pinned", { hostId: 42, pinned: false, requestId: "p1" }]);
  });
});

describe("setSessionProject", () => {
  it("posts the move; a gone project rejects with the machine's reason", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 200, data: { ok: true } });
    await expect(setSessionProject(42, "wren", "garden")).resolves.toEqual({ ok: true });
    expect(authApi.post).toHaveBeenCalledWith("/identities/wren/project", { hostId: 42, project: "garden", requestId: expect.any(String) });
    vi.mocked(authApi.post).mockRejectedValueOnce(axiosError(409, { error: 'the project "Garden" is archived', code: "project_archived" }));
    await expect(setSessionProject(42, "wren", "garden")).rejects.toMatchObject({ message: 'the project "Garden" is archived' });
  });

  it("one machine's changes go out one after another, in click order", async () => {
    const order: string[] = [];
    let release!: () => void;
    vi.mocked(authApi.post)
      .mockImplementationOnce(async () => {
        order.push("move-start");
        await new Promise<void>((r) => (release = r));
        order.push("move-end");
        return { status: 200, data: { ok: true } };
      })
      .mockImplementationOnce(async () => {
        order.push("second");
        return { status: 200, data: { ok: true } };
      });
    const a = setSessionProject(42, "wren", "garden");
    const b = setSessionProject(42, "wren", null);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["move-start"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["move-start", "move-end", "second"]);
  });
});

describe("projects", () => {
  it("createProject returns the slug the machine chose", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 200, data: { ok: true, result: { slug: "garden-2" } } });
    await expect(createProject(42, "Garden", "farm")).resolves.toEqual({ ok: true, slug: "garden-2" });
    expect(authApi.post).toHaveBeenCalledWith("/projects", { hostId: 42, displayName: "Garden", parent: "farm", requestId: expect.any(String) });
  });

  it("renameProject sends only the name", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 200, data: { ok: true, result: {} } });
    await renameProject(42, "team", "Dream Team");
    expect(authApi.post).toHaveBeenCalledWith("/projects/team/rename", { hostId: 42, displayName: "Dream Team", requestId: expect.any(String) });
  });

  it("setProjectParent: a refusal rejects with the reason; still waiting after the follow-ups says so", async () => {
    vi.mocked(authApi.post).mockRejectedValueOnce(
      axiosError(409, { error: "cannot move a project inside itself or its own sub-project", code: "into_itself" }),
    );
    await expect(setProjectParent(42, "a", "b")).rejects.toMatchObject({ code: "into_itself" });
    vi.mocked(authApi.post).mockResolvedValue({ status: 202, data: { pending: true, requestId: "m1" } });
    await expect(setProjectParent(42, "a", null)).rejects.toThrow(/still working on it/);
  });
});

describe("updateIdentity", () => {
  it("puts the edit with a request id and returns the echo", async () => {
    vi.mocked(authApi.put).mockResolvedValueOnce({ status: 200, data: { identityKey: "wren", task: "x", pinned: false } });
    const r = await updateIdentity("wren", { task: "x" }, null, 42);
    expect(r).toEqual({ identityKey: "wren", task: "x" });
    const fd = vi.mocked(authApi.put).mock.calls[0]?.[1] as FormData;
    expect(JSON.parse(String(fd.get("data")))).toMatchObject({ task: "x", hostId: 42, requestId: expect.any(String) });
  });

  it("a refusal rejects with the machine's reason", async () => {
    vi.mocked(authApi.put).mockRejectedValueOnce(axiosError(409, { error: "it's being archived", code: "being_archived" }));
    await expect(updateIdentity("wren", { task: "x" }, null, 42)).rejects.toMatchObject({ name: "MachineChangeError", message: "it's being archived" });
  });

  it("still waiting: asks by its id (never sends it again), then reads the agent back", async () => {
    vi.mocked(authApi.put).mockResolvedValueOnce({ status: 202, data: { pending: true } });
    vi.mocked(authApi.get)
      .mockResolvedValueOnce({ status: 202, data: { pending: true } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true } })
      .mockResolvedValueOnce({ status: 200, data: [{ identityKey: "wren", task: "x", pinned: true }] });
    const r = await updateIdentity("wren", { task: "x" }, null, 42);
    expect(authApi.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(authApi.get).mock.calls[0]?.[0]).toMatch(/^\/machine-changes\/42\/.+/);
    expect(r).toEqual({ identityKey: "wren", task: "x" });
  });

  it("no answer at all (timed out): asks by its id too; still working after that says so", async () => {
    const lost = new axios.AxiosError("timeout", "ECONNABORTED");
    vi.mocked(authApi.put).mockRejectedValueOnce(lost);
    vi.mocked(authApi.get).mockResolvedValue({ status: 202, data: { pending: true } });
    await expect(updateIdentity("wren", { task: "x" }, null, 42)).rejects.toThrow(/still working on it/);
    expect(authApi.get).toHaveBeenCalledTimes(3);
  });
});
