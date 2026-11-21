/**
 * matrix-room-tag-client unit tests (Phase 117 Plan 117-02).
 *
 * Coverage: getRoomTags GET happy path + failure modes + setRoomProjectTag
 * D-05a 5-step read-modify-write cycle including D-06 single-project
 * invariant (strip every existing `u.project.*` before adding the new one).
 *
 * Mocking strategy mirrors matrix-admin-client.test.ts:
 *   - global `fetch` stubbed per test via `vi.stubGlobal("fetch", vi.fn())`
 *   - `getMatrixAdminCreds` mocked via `vi.mock("./matrix-admin-creds-store.js", ...)`
 *   - `ensureUserToken` mocked via `vi.mock("./matrix-admin-client.js", ...)` so
 *     tests exercise the room-tag layer in isolation from the loginAsUser
 *     round-trip (matrix-admin-client.test.ts already exercises loginAsUser).
 *   - `databaseLogger` mocked so `.error()` calls don't spam stderr.
 *
 * NO real Synapse is hit here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./matrix-admin-creds-store.js", () => ({
  getMatrixAdminCreds: vi.fn(),
}));

vi.mock("./matrix-admin-client.js", () => ({
  ensureUserToken: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  databaseLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import { getRoomTags, setRoomProjectTag, setRoomPinned } from "./matrix-room-tag-client.js";
import { getMatrixAdminCreds } from "./matrix-admin-creds-store.js";
import { ensureUserToken } from "./matrix-admin-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HAPPY_CREDS = {
  homeserverBase: "https://matrix.example.com",
  userId: "@skynet-admin:matrix.example.com",
  accessToken: "admin-tok",
  password: "admin-plaintext-password",
};

const USER_MXID = "@ash:harbor.example-tailnet.ts.net";
const ROOM_ID = "!abc:harbor.example-tailnet.ts.net";
const EXPECTED_URL =
  "https://matrix.example.com/_matrix/client/v3/user/" +
  encodeURIComponent(USER_MXID) +
  "/rooms/" +
  encodeURIComponent(ROOM_ID) +
  "/account_data/m.tag";

/** Build a fake Response-shaped object with `.ok`, `.status`, `.json()`. */
function mockFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Convenience: stub fetch to return a single canned response. */
function stubFetchOk(status: number, body: unknown): void {
  const mock = vi.fn(async () => mockFetchResponse(status, body));
  vi.stubGlobal("fetch", mock);
}

/** Convenience: stub fetch to throw an AbortError. */
function stubFetchAbort(): void {
  const mock = vi.fn(async () => {
    throw new DOMException("The user aborted a request.", "AbortError");
  });
  vi.stubGlobal("fetch", mock);
}

beforeEach(() => {
  vi.mocked(getMatrixAdminCreds).mockReset();
  vi.mocked(getMatrixAdminCreds).mockResolvedValue(HAPPY_CREDS);
  vi.mocked(ensureUserToken).mockReset();
  vi.mocked(ensureUserToken).mockResolvedValue({ ok: true, token: "user-tok" });
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// getRoomTags
// ---------------------------------------------------------------------------

describe("getRoomTags", () => {
  it("Test 1: happy 200 → returns {ok:true, tags} and uses PER-USER token", async () => {
    const tags = { "m.favourite": {}, "u.project.alpha": {} };
    const fetchMock = vi.fn(async () => mockFetchResponse(200, { tags }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRoomTags(USER_MXID, ROOM_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tags).toEqual(tags);
    }

    // URL correctness — percent-encoded userMxid + roomId.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(EXPECTED_URL);
    expect((opts as RequestInit).method).toBe("GET");

    // Auth header carries the PER-USER token minted by ensureUserToken,
    // NOT the admin token from getMatrixAdminCreds.
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer user-tok");
    expect(headers.Authorization).not.toBe("Bearer admin-tok");
  });

  it("Test 2: 404 → {ok:true, tags: {}} (absent m.tag is a valid state)", async () => {
    stubFetchOk(404, { errcode: "M_NOT_FOUND" });
    const result = await getRoomTags(USER_MXID, ROOM_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tags).toEqual({});
    }
  });

  it("Test 3: non-2xx non-404 (500) → {ok:false, status:500, error:'matrix_room_tag_non_2xx'}", async () => {
    stubFetchOk(500, { errcode: "M_UNKNOWN" });
    const result = await getRoomTags(USER_MXID, ROOM_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toBe("matrix_room_tag_non_2xx");
    }
  });

  it("Test 4: creds missing → {ok:false, status:500, error:'matrix_admin_creds_missing'}", async () => {
    vi.mocked(getMatrixAdminCreds).mockResolvedValue(null);
    // fetch should NOT be called.
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called when creds are missing");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRoomTags(USER_MXID, ROOM_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toBe("matrix_admin_creds_missing");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Test 5: timeout (AbortError) → {ok:false, status:504, error:'matrix_room_tag_timeout'}", async () => {
    stubFetchAbort();
    const result = await getRoomTags(USER_MXID, ROOM_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(504);
      expect(result.error).toBe("matrix_room_tag_timeout");
    }
  });

  it("Test 6: ensureUserToken failure → returns the AdminErr verbatim", async () => {
    vi.mocked(ensureUserToken).mockResolvedValue({
      ok: false,
      status: 403,
      error: "admin_api_non_2xx",
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called when token mint fails");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRoomTags(USER_MXID, ROOM_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Verbatim propagation — same status and error code as ensureUserToken emitted.
      expect(result.status).toBe(403);
      expect(result.error).toBe("admin_api_non_2xx");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setRoomProjectTag — read-modify-write (D-05a)
// ---------------------------------------------------------------------------

describe("setRoomProjectTag", () => {
  it("Test 7: assign — read-modify-write preserves other tags, adds u.project.<slug>, and unpins (drops m.favourite)", async () => {
    const currentTags = { "m.favourite": {}, "m.lowpriority": {} };
    // First call GET, second call PUT.
    const fetchMock = vi.fn(async (_url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return mockFetchResponse(200, { tags: currentTags });
      }
      return mockFetchResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setRoomProjectTag(USER_MXID, ROOM_ID, "alpha");
    // Resolves with what the write left on the room.
    expect(result).toEqual({ ok: true, project: "alpha", pinned: false });

    // Exactly one GET and one PUT.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const getCall = fetchMock.mock.calls[0];
    const putCall = fetchMock.mock.calls[1];
    expect((getCall[1] as RequestInit).method).toBe("GET");
    expect((putCall[1] as RequestInit).method).toBe("PUT");

    // PUT body keeps the other tag, adds the project, and drops the pin —
    // pinned and in-a-project are exclusive.
    const putBody = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(putBody).toEqual({
      tags: {
        "m.lowpriority": {},
        "u.project.alpha": {},
      },
    });
  });

  it("Test 8: rewrite — strips existing u.project.old, keeps other tags", async () => {
    const currentTags = { "m.lowpriority": {}, "u.project.old": {} };
    const fetchMock = vi.fn(async (_url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return mockFetchResponse(200, { tags: currentTags });
      }
      return mockFetchResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setRoomProjectTag(USER_MXID, ROOM_ID, "new");
    expect(result.ok).toBe(true);

    const putCall = fetchMock.mock.calls[1];
    const putBody = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(putBody).toEqual({
      tags: {
        "m.lowpriority": {},
        "u.project.new": {},
      },
    });
    // Old project tag is REMOVED.
    expect(putBody.tags["u.project.old"]).toBeUndefined();
  });

  it("Test 9: D-06 single-project invariant — strips ALL existing u.project.* keys", async () => {
    const currentTags = {
      "u.project.a": {},
      "u.project.b": {},
      "m.lowpriority": {},
    };
    const fetchMock = vi.fn(async (_url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return mockFetchResponse(200, { tags: currentTags });
      }
      return mockFetchResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setRoomProjectTag(USER_MXID, ROOM_ID, "c");
    expect(result.ok).toBe(true);

    const putCall = fetchMock.mock.calls[1];
    const putBody = JSON.parse((putCall[1] as RequestInit).body as string);

    // Exactly ONE key matching /^u\.project\./ and it is u.project.c.
    const projectKeys = Object.keys(putBody.tags).filter((k) =>
      /^u\.project\./.test(k),
    );
    expect(projectKeys).toEqual(["u.project.c"]);
    // Plus the other tag survives.
    expect(putBody.tags["m.lowpriority"]).toEqual({});
  });

  it("Test 10: clear (slug=null) — removes u.project.old and any stray pin, keeps other tags, adds nothing", async () => {
    const currentTags = { "m.favourite": {}, "u.project.old": {}, "m.lowpriority": {} };
    const fetchMock = vi.fn(async (_url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return mockFetchResponse(200, { tags: currentTags });
      }
      return mockFetchResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setRoomProjectTag(USER_MXID, ROOM_ID, null);
    expect(result).toEqual({ ok: true, project: null, pinned: false });

    const putCall = fetchMock.mock.calls[1];
    const putBody = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(putBody).toEqual({ tags: { "m.lowpriority": {} } });
  });

  it("Test 11: clear on already-empty (404 GET) — PUT {tags:{}} for byte-consistency", async () => {
    // GET returns 404 (absent m.tag). clear (slug=null) still issues a PUT
    // of {tags:{}} for byte-consistency with the assign path.
    const fetchMock = vi.fn(async (_url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return mockFetchResponse(404, { errcode: "M_NOT_FOUND" });
      }
      return mockFetchResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setRoomProjectTag(USER_MXID, ROOM_ID, null);
    expect(result.ok).toBe(true);

    // Exactly one PUT and its body is {tags: {}}.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const putCall = fetchMock.mock.calls[1];
    expect((putCall[1] as RequestInit).method).toBe("PUT");
    const putBody = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(putBody).toEqual({ tags: {} });
  });

  it("Test 12: invalid slug — throws BEFORE any HTTP call", async () => {
    const fetchMock = vi.fn(async () => mockFetchResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      setRoomProjectTag(USER_MXID, ROOM_ID, "Alpha"),
    ).rejects.toThrow(/invalid project slug/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Test 13: GET failure propagates — no PUT issued", async () => {
    // GET returns 500; PUT must never be issued.
    const fetchMock = vi.fn(async (_url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return mockFetchResponse(500, { errcode: "M_UNKNOWN" });
      }
      // If PUT ever fires the test fails via the assertion below on call count / method.
      return mockFetchResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setRoomProjectTag(USER_MXID, ROOM_ID, "alpha");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toBe("matrix_room_tag_non_2xx");
    }
    // Exactly one call — GET only.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("Test 14: PUT failure → {ok:false, status:500, error:'matrix_room_tag_non_2xx'}", async () => {
    const fetchMock = vi.fn(async (_url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return mockFetchResponse(200, { tags: { "m.favourite": {} } });
      }
      return mockFetchResponse(500, { errcode: "M_UNKNOWN" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setRoomProjectTag(USER_MXID, ROOM_ID, "alpha");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toBe("matrix_room_tag_non_2xx");
    }
  });

  it("Test 15: encodeURIComponent path safety — @ and : percent-encoded (and path-traversal chars would be too)", async () => {
    const fetchMock = vi.fn(async () => mockFetchResponse(200, { tags: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await getRoomTags("@user:host", "!id:host");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    // @ → %40, : → %3A (both mxid-critical characters percent-encoded so a
    // hostile value like "@..%2Fadmin" can't escape the /user/ path segment).
    expect(url).toContain("%40user%3Ahost");
    // ! is a URI-unreserved character per RFC 3986 § 2.3 so encodeURIComponent
    // leaves it verbatim — same behavior matrix-admin-client.ts:1315-1316
    // shows for roomIds. The path-traversal defense is still upheld because
    // `/` and `.` in a roomId WOULD be encoded (verified in Test 15b below).
    expect(url).toContain("!id%3Ahost");
    // Sanity: the raw @user:host form MUST NOT appear (would defeat path-
    // traversal defense on the mxid segment).
    expect(url).not.toMatch(/\/user\/@user:host\//);
  });

  it("Test 15b: encodeURIComponent path-traversal defense — / in mxid or roomId is encoded", async () => {
    const fetchMock = vi.fn(async () => mockFetchResponse(200, { tags: {} }));
    vi.stubGlobal("fetch", fetchMock);

    // Hostile input: attempts to inject a path segment via / or ..
    await getRoomTags("@x/../admin:host", "!bad/../id:host");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    // %2F is the encoded /. If encodeURIComponent were skipped, the URL
    // would contain a real / that Matrix could interpret as a path segment
    // break — this is the T-117-02-02 defense in action.
    expect(url).toContain("%2F");
    // No raw /../ path-traversal pattern survives.
    expect(url).not.toContain("/../");
  });
});

// ---------------------------------------------------------------------------
// setRoomPinned — the sidebar pin is the chat server's favourite tag
// ---------------------------------------------------------------------------

describe("setRoomPinned", () => {
  function stubTags(currentTags: Record<string, unknown> | null) {
    const fetchMock = vi.fn(async (_url, opts) => {
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return currentTags === null
          ? mockFetchResponse(404, { errcode: "M_NOT_FOUND" })
          : mockFetchResponse(200, { tags: currentTags });
      }
      return mockFetchResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const putBodyOf = (fetchMock: ReturnType<typeof vi.fn>) =>
    JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);

  it("pin: adds m.favourite, strips every project tag, keeps other tags — as the user", async () => {
    const fetchMock = stubTags({ "u.project.a": {}, "u.project.b": {}, "m.lowpriority": {} });
    const result = await setRoomPinned(USER_MXID, ROOM_ID, true);
    expect(result).toEqual({ ok: true, project: null, pinned: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("PUT");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/account_data/m.tag");
    expect(putBodyOf(fetchMock)).toEqual({ tags: { "m.lowpriority": {}, "m.favourite": {} } });
  });

  it("pin on a room with no tags yet (404) writes just the favourite", async () => {
    const fetchMock = stubTags(null);
    await setRoomPinned(USER_MXID, ROOM_ID, true);
    expect(putBodyOf(fetchMock)).toEqual({ tags: { "m.favourite": {} } });
  });

  it("pin keeps an existing favourite's content (another app's order)", async () => {
    const fetchMock = stubTags({ "m.favourite": { order: 0.25 } });
    await setRoomPinned(USER_MXID, ROOM_ID, true);
    expect(putBodyOf(fetchMock)).toEqual({ tags: { "m.favourite": { order: 0.25 } } });
  });

  it("unpin: removes only m.favourite", async () => {
    const fetchMock = stubTags({ "m.favourite": {}, "m.lowpriority": {}, "u.other": {} });
    await setRoomPinned(USER_MXID, ROOM_ID, false);
    expect(putBodyOf(fetchMock)).toEqual({ tags: { "m.lowpriority": {}, "u.other": {} } });
  });

  it("unpin on a room that somehow also has a project reports the project it kept", async () => {
    stubTags({ "m.favourite": {}, "u.project.alpha": {} });
    const result = await setRoomPinned(USER_MXID, ROOM_ID, false);
    expect(result).toEqual({ ok: true, project: "alpha", pinned: false });
  });

  it("a failed read writes nothing", async () => {
    const fetchMock = vi.fn(async () => mockFetchResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    const result = await setRoomPinned(USER_MXID, ROOM_ID, true);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
