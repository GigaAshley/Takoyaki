import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Phase 117 Plan 117-06 Task 1 — project-list-api ─────────────────────────
//
// Locks the wire shape of the three /projects fetch wrappers landed by
// 117-04's backend route:
//
//   GET  /projects?hostId=<n>          → { projects: ProjectSummary[] }
//   POST /projects                     body { hostId, displayName }
//                                        → { ok: true, slug }
//   POST /projects/:slug/archive       body { hostId }
//                                        → { ok: true }
//
// Byte-shape mirror of identity-archive-api.test.ts. `@/main-axios` is mocked
// at module level; handleApiError is stubbed to throw so the caller's error
// path is observable via rejects.toThrow.

vi.mock("@/main-axios", () => ({
  authApi: {
    post: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
  },
  handleApiError: (err: unknown, operation: string): never => {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "unknown error";
    throw new Error(`${operation}: ${msg}`);
  },
}));

import {
  listProjects,
  createProject,
  archiveProject,
  getProjectFile,
  updateProjectFile,
} from "@/api/project-list-api";
import { authApi } from "@/main-axios";

describe("Phase 117 Plan 117-06 Task 1 — project-list-api", () => {
  beforeEach(() => {
    vi.mocked(authApi.get).mockReset();
    vi.mocked(authApi.post).mockReset();
    vi.mocked(authApi.put).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Test 1 — listProjects happy path
  it("Test 1 (listProjects happy): GET /projects?hostId=1 returns the parsed body", async () => {
    vi.mocked(authApi.get).mockResolvedValueOnce({
      data: {
        projects: [{ slug: "a", displayName: "Alpha", archived: false }],
      },
    });

    const result = await listProjects(1);

    expect(authApi.get).toHaveBeenCalledTimes(1);
    expect(authApi.get).toHaveBeenCalledWith("/projects?hostId=1");
    expect(result).toEqual({
      projects: [{ slug: "a", displayName: "Alpha", archived: false }],
    });
  });

  // Test 2 — listProjects error path (500)
  it("Test 2 (listProjects 500): non-2xx causes listProjects to throw via handleApiError", async () => {
    vi.mocked(authApi.get).mockRejectedValueOnce(
      new Error("Request failed with status code 500"),
    );

    await expect(listProjects(1)).rejects.toThrow(/list projects/i);
  });

  // Test 3 — createProject happy path
  it("Test 3 (createProject happy): POST /projects with body {hostId, displayName} returns { ok: true, slug }", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({
      data: { ok: true, slug: "my-project" },
    });

    const result = await createProject(1, "My Project");

    expect(authApi.post).toHaveBeenCalledTimes(1);
    expect(authApi.post).toHaveBeenCalledWith("/projects", {
      hostId: 1,
      displayName: "My Project",
    });
    expect(result).toEqual({ ok: true, slug: "my-project" });
  });

  // Test 4 — createProject 409 duplicate-slug: caller must be able to detect
  //          the collision from the propagated error (via handleApiError,
  //          which preserves the underlying axios error shape upstream —
  //          this test locks the operation label so the callsite catch can
  //          distinguish create errors from other API surfaces).
  it("Test 4 (createProject 409): duplicate-slug is surfaced through handleApiError with the 'create project' operation label", async () => {
    vi.mocked(authApi.post).mockRejectedValueOnce(
      new Error("Request failed with status code 409"),
    );

    await expect(createProject(1, "My Project")).rejects.toThrow(
      /create project/i,
    );
  });

  // Test 5 — archiveProject sends the confirmed list and a request id
  it("Test 5 (archiveProject happy): POST /projects/alpha/archive with {hostId, expected, requestId} → done", async () => {
    const expected = { projects: ["alpha"], agents: ["finch"], apps: [] };
    vi.mocked(authApi.post).mockResolvedValueOnce({
      status: 200,
      data: { ok: true, requestId: "r1", result: { projects: [{ slug: "alpha", archivedAs: "alpha" }], agents: ["finch"], apps: [], rooms: [] } },
    });

    const answer = await archiveProject(1, "alpha", expected);

    expect(authApi.post).toHaveBeenCalledTimes(1);
    const [url, body] = vi.mocked(authApi.post).mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("/projects/alpha/archive");
    expect(body).toMatchObject({ hostId: 1, expected });
    expect(typeof body.requestId).toBe("string");
    expect(answer.done).toBe(true);
  });

  // Test 6 — still working: the same request is sent again with the same id
  it("Test 6 (archiveProject still working): resends with the same request id until it's done", async () => {
    const onStillWorking = vi.fn();
    vi.mocked(authApi.post)
      .mockResolvedValueOnce({ status: 202, data: { pending: true, requestId: "r2" } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true, requestId: "r2", result: {} } });

    const answer = await archiveProject(1, "abc-123", { projects: ["abc-123"], agents: [], apps: [] }, onStillWorking);

    expect(onStillWorking).toHaveBeenCalledTimes(1);
    expect(authApi.post).toHaveBeenCalledTimes(2);
    expect((vi.mocked(authApi.post).mock.calls[1] as [string, { requestId: string }])[1].requestId).toBe("r2");
    expect(answer).toMatchObject({ done: true, requestId: "r2" });
  });

  // Test 6b — the connection drops before any answer: asked again by id, not treated as failed
  it("Test 6b (archiveProject no answer): a dropped connection is asked about again with the same id", async () => {
    vi.mocked(authApi.post)
      .mockRejectedValueOnce(Object.assign(new Error("Network Error"), { isAxiosError: true, response: undefined }))
      .mockResolvedValueOnce({ status: 200, data: { ok: true, requestId: "r3", result: {} } });

    const answer = await archiveProject(1, "alpha", { projects: ["alpha"], agents: [], apps: [] });

    expect(authApi.post).toHaveBeenCalledTimes(2);
    const first = (vi.mocked(authApi.post).mock.calls[0] as [string, { requestId: string }])[1].requestId;
    const second = (vi.mocked(authApi.post).mock.calls[1] as [string, { requestId: string }])[1].requestId;
    expect(second).toBe(first);
    expect(answer.done).toBe(true);
  });

  // ─── Phase 117 followup — getProjectFile / updateProjectFile ────────────────

  it("Test 7 (getProjectFile happy): GET /projects/alpha/file?hostId=1 returns { markdown }", async () => {
    vi.mocked(authApi.get).mockResolvedValueOnce({
      data: { markdown: "---\ndisplayName: 'Alpha'\n---\nbody" },
    });

    const result = await getProjectFile(1, "alpha");

    expect(authApi.get).toHaveBeenCalledTimes(1);
    expect(authApi.get).toHaveBeenCalledWith("/projects/alpha/file?hostId=1");
    expect(result).toEqual({
      markdown: "---\ndisplayName: 'Alpha'\n---\nbody",
    });
  });

  it("Test 8 (getProjectFile error): non-2xx surfaces through handleApiError with the 'read project file' operation label", async () => {
    vi.mocked(authApi.get).mockRejectedValueOnce(
      new Error("Request failed with status code 500"),
    );

    await expect(getProjectFile(1, "alpha")).rejects.toThrow(
      /read project file/i,
    );
  });

  it("Test 9 (updateProjectFile happy): PUT /projects/alpha/file with body {hostId, contents} returns { markdown } (server-echo)", async () => {
    vi.mocked(authApi.put).mockResolvedValueOnce({
      data: { markdown: "new body" },
    });

    const result = await updateProjectFile(1, "alpha", "new body");

    expect(authApi.put).toHaveBeenCalledTimes(1);
    expect(authApi.put).toHaveBeenCalledWith("/projects/alpha/file", {
      hostId: 1,
      contents: "new body",
    });
    expect(result).toEqual({ markdown: "new body" });
  });

  it("Test 10 (updateProjectFile error): non-2xx surfaces through handleApiError with the 'update project file' operation label", async () => {
    vi.mocked(authApi.put).mockRejectedValueOnce(
      new Error("Request failed with status code 500"),
    );

    await expect(updateProjectFile(1, "alpha", "body")).rejects.toThrow(
      /update project file/i,
    );
  });
});
