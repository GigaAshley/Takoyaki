import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

// Archive an agent, a role or an app: each goes to its machine's front door
// (machine-changes-api's sendMachineChange, in the machine's click order).
// These tests lock each one's request and how the machine's answers come back.

vi.mock("@/main-axios", () => ({
  authApi: { post: vi.fn(), get: vi.fn() },
  handleApiError: (err: unknown, operation: string): never => {
    throw new Error(`${operation}: ${err instanceof Error ? err.message : String(err)}`);
  },
}));

import { authApi } from "@/main-axios";
import { archiveIdentity } from "@/api/identity-archive-api";
import { archiveApp } from "@/api/apps-archive-api";
import { archiveRole, getRoleArchivePreflight } from "@/api/role-archive-api";
import { MachineChangeError } from "@/api/machine-changes-api";

function axiosError(status: number, data: unknown): Error {
  const err = new axios.AxiosError("Request failed", "ERR_BAD_RESPONSE");
  err.response = { status, data, statusText: "", headers: {}, config: {} as never };
  return err;
}

beforeEach(() => {
  vi.mocked(authApi.post).mockReset();
  vi.mocked(authApi.get).mockReset();
});

describe("archiveIdentity", () => {
  it("the server going away while it waits its turn isn't a failure: asks again after a pause", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(authApi.post).mockResolvedValueOnce({ status: 202, data: { pending: true, requestId: "r7" } });
      vi.mocked(authApi.get)
        .mockRejectedValueOnce(axiosError(502, "<html>bad gateway</html>"))
        .mockRejectedValueOnce(Object.assign(new axios.AxiosError("Network Error", "ERR_NETWORK")))
        .mockResolvedValueOnce({ status: 200, data: { ok: true } });
      const p = archiveIdentity(42, "wren");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(p).resolves.toMatchObject({ done: true, requestId: "r7" });
      expect(authApi.get).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the server away for longer than a minute: left to the machine's report, not failed", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(authApi.post).mockResolvedValueOnce({ status: 202, data: { pending: true, requestId: "r8" } });
      vi.mocked(authApi.get).mockRejectedValue(axiosError(504, ""));
      const p = archiveIdentity(42, "wren");
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(p).resolves.toEqual({ done: false, requestId: "r8" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the server restarting while it holds the first request isn't a failure either: asks by id", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(authApi.post).mockRejectedValueOnce(axiosError(502, "<html>bad gateway</html>"));
      vi.mocked(authApi.get).mockResolvedValueOnce({ status: 200, data: { ok: true } });
      const p = archiveIdentity(42, "wren");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(p).resolves.toMatchObject({ done: true });
      expect(vi.mocked(authApi.get).mock.calls[0][0]).toMatch(/^\/machine-changes\/42\//);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updated while it waited (stale_client on a follow-up): stops asking, not failed", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 202, data: { pending: true, requestId: "r5" } });
    vi.mocked(authApi.get).mockRejectedValueOnce(axiosError(409, { error: "stale_client" }));
    await expect(archiveIdentity(42, "wren")).resolves.toEqual({ done: false, requestId: "r5" });
  });

  it("turned away as stale on the first request: says to reload and try again", async () => {
    vi.mocked(authApi.post).mockRejectedValueOnce(axiosError(409, { error: "stale_client" }));
    await expect(archiveIdentity(42, "wren")).rejects.toMatchObject({ code: "stale_client", message: "the app was just updated — reload, then try again" });
  });

  it("the server's own 503 (the machine updating) is still an answer", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 202, data: { pending: true, requestId: "r6" } });
    vi.mocked(authApi.get).mockRejectedValueOnce(axiosError(503, { error: "this machine is still updating", code: "not_installed" }));
    await expect(archiveIdentity(42, "wren")).rejects.toMatchObject({ name: "MachineChangeError", code: "not_installed" });
  });

  it("posts to the agent's archive route with a request id and returns the machine's answer", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 200, data: { ok: true, requestId: "x", result: { claimed: ["wren"] } } });
    const r = await archiveIdentity(42, "wren");
    expect(authApi.post).toHaveBeenCalledWith("/identities/wren/archive", { hostId: 42, requestId: expect.any(String) });
    expect(r).toMatchObject({ done: true });
  });

  it("a refusal rejects with the machine's reason", async () => {
    vi.mocked(authApi.post).mockRejectedValueOnce(
      axiosError(409, { error: "an archived agent named 'wren' is already in the archive", code: "archive_slot_taken" }),
    );
    await expect(archiveIdentity(42, "wren")).rejects.toMatchObject({
      name: "MachineChangeError",
      code: "archive_slot_taken",
      message: "an archived agent named 'wren' is already in the archive",
    });
  });

  it("still waiting its turn: says so, then asks by id", async () => {
    const still = vi.fn();
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 202, data: { pending: true, requestId: "r9" } });
    vi.mocked(authApi.get).mockResolvedValueOnce({ status: 200, data: { ok: true } });
    const r = await archiveIdentity(42, "wren", still);
    expect(still).toHaveBeenCalledTimes(1);
    expect(authApi.get).toHaveBeenCalledWith("/machine-changes/42/r9");
    expect(r).toMatchObject({ done: true });
  });

  it("encodes the agent's name in the path", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 200, data: { ok: true } });
    await archiveIdentity(1, "a b");
    expect(vi.mocked(authApi.post).mock.calls[0][0]).toBe("/identities/a%20b/archive");
  });
});

describe("archiveApp", () => {
  it("posts to the app's archive route", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 200, data: { ok: true } });
    await archiveApp(42, "my-app");
    expect(authApi.post).toHaveBeenCalledWith("/apps/42/my-app/archive", { requestId: expect.any(String) });
  });

  it("a failure rejects with the machine's reason", async () => {
    vi.mocked(authApi.post).mockRejectedValueOnce(axiosError(500, { error: "archive-app.sh failed (1)", code: "archive_failed" }));
    await expect(archiveApp(42, "my-app")).rejects.toBeInstanceOf(MachineChangeError);
  });
});

describe("role archive", () => {
  it("the preflight returns who the machine says holds the role", async () => {
    vi.mocked(authApi.get).mockResolvedValueOnce({
      status: 200,
      data: { ok: true, result: { role: "ops", displayName: "Ops", agents: [{ name: "ann", displayName: "Ann", task: "" }] } },
    });
    const c = await getRoleArchivePreflight(42, "ops");
    expect(authApi.get).toHaveBeenCalledWith("/roles/ops/archive-preflight?hostId=42");
    expect(c.agents.map((a) => a.name)).toEqual(["ann"]);
  });

  it("archives exactly the agents the user confirmed", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({ status: 200, data: { ok: true } });
    await archiveRole(42, "ops", ["ann"]);
    expect(authApi.post).toHaveBeenCalledWith("/roles/ops/archive", {
      hostId: 42,
      expected: { agents: ["ann"] },
      requestId: expect.any(String),
    });
  });

  it("a changed list comes back with the machine's current one", async () => {
    vi.mocked(authApi.post).mockRejectedValueOnce(
      axiosError(409, { error: "changed", code: "contents_changed", result: { agents: [{ name: "ann" }, { name: "bob" }] } }),
    );
    const err = await archiveRole(42, "ops", ["ann"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MachineChangeError);
    expect((err as MachineChangeError).code).toBe("contents_changed");
    expect((err as MachineChangeError).result).toEqual({ agents: [{ name: "ann" }, { name: "bob" }] });
  });
});
