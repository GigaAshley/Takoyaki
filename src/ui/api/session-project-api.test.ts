import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Phase 117 Plan 117-06 Task 1 — session-project-api ──────────────────────
//
// Locks the wire shape of the two session-project fetch wrappers landed by
// 117-05's backend route:
//
//   POST /identities/:key/project              body { hostId, project, requestId } (see quick-change-apis.test.ts)
//                                                → { ok: true }
//   POST /relay-rooms/:roomId/project          body { userMxid, project }
//                                                → { ok: true }
//
// Both `project` params accept slug string or null (null clears the field).
// Byte-shape mirror of identity-archive-api.test.ts.

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
  setSessionProject,
  setRelayRoomProject,
} from "@/api/session-project-api";
import { authApi } from "@/main-axios";

describe("Phase 117 Plan 117-06 Task 1 — session-project-api", () => {
  beforeEach(() => {
    vi.mocked(authApi.post).mockReset();
    vi.mocked(authApi.get).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Test 11 — setRelayRoomProject assign
  //   roomId is "!room:host" — encodeURIComponent encodes ':' → '%3A' but
  //   leaves '!' as-is per its RFC 3986 sub-delims-are-safe contract. The
  //   URL segment must match the exact output of encodeURIComponent(roomId)
  //   (verified inline against ':' encoding, which IS load-bearing — an
  //   unencoded ':' would split the path segment).
  it("Test 11 (setRelayRoomProject assign): POSTs /relay-rooms/<encoded roomId>/project with body {userMxid, project}; ':' becomes '%3A'", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({
      data: { ok: true },
    });

    const result = await setRelayRoomProject(
      "!room:host",
      "@ash:host",
      "alpha",
    );

    expect(authApi.post).toHaveBeenCalledTimes(1);
    const [calledUrl, calledBody] = vi.mocked(authApi.post).mock.calls[0] as [
      string,
      { userMxid: string; project: string | null },
    ];
    // Load-bearing: ':' MUST be percent-encoded (else path segment splits).
    expect(calledUrl).toBe("/relay-rooms/!room%3Ahost/project");
    // Sanity: matches encodeURIComponent verbatim.
    expect(calledUrl).toBe(
      `/relay-rooms/${encodeURIComponent("!room:host")}/project`,
    );
    expect(calledBody).toEqual({ userMxid: "@ash:host", project: "alpha" });
    expect(result).toEqual({ ok: true });
  });

  // Test 12 — setRelayRoomProject clear
  it("Test 12 (setRelayRoomProject clear): null projectSlug produces body.project === null", async () => {
    vi.mocked(authApi.post).mockResolvedValueOnce({
      data: { ok: true },
    });

    await setRelayRoomProject("!room:host", "@ash:host", null);

    const calledBody = vi.mocked(authApi.post).mock.calls[0][1] as {
      userMxid: string;
      project: string | null;
    };
    expect(calledBody.project).toBeNull();
    expect(calledBody.userMxid).toBe("@ash:host");
  });
});
