/**
 * PUT /identities/:identityKey — the agent window's edits (name, title, task, colour, voice,
 * picture), sent to the machine's front door (fleet-change agent-edit) so only the lines being
 * changed are written, in turn with the machine's other changes. What the machine writes is
 * fleet-change.test.sh's; here: what the route sends, the picture saved first under a fresh
 * name, the answers, and the echo read back afterwards.
 *
 * Bare Express + Node http.request; AuthManager, db, logger, artifact-reader, SSH and the
 * front door are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Auth manager mock — always authenticates as "test-user" unless overridden
// ---------------------------------------------------------------------------

let mockUserId: string | null = "test-user";

vi.mock("../../utils/auth-manager.js", () => {
  const AuthManager = {
    getInstance: () => ({
      createAuthMiddleware: () =>
        (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction,
        ) => {
          if (mockUserId === null) {
            return res.status(401).json({ error: "Unauthorized" });
          }
          (req as express.Request & { userId: string }).userId = mockUserId;
          next();
        },
    }),
  };
  return { AuthManager };
});

// ---------------------------------------------------------------------------
// nanoid mock — predictable ids
// ---------------------------------------------------------------------------

vi.mock("nanoid", () => ({
  nanoid: () => "nano-generated-id",
}));

// ---------------------------------------------------------------------------
// In-memory identities table shim + captured update .set() calls
// ---------------------------------------------------------------------------

// Phase 66 Plan 04: identities row narrowed to 5 surviving columns.
// Cosmetics live on disk. The PUT handler was already flipped in Plan 02
// to write disk-side, and the store update only bumps `updatedAt` — Test 1
// already asserts `dbState.lastUpdateSetKeys === ["updatedAt"]`. Post-drop,
// the seed row no longer has cosmetic columns to preserve.
type IdentityRow = {
  id: string;
  userId: string;
  identityKey: string;
  createdAt: string;
  updatedAt: string;
};

const dbState: {
  identities: IdentityRow[];
  // Captures every column key passed to .set(...) — Test 1 asserts NO
  // cosmetic keys appear (only updatedAt) post-flip.
  lastUpdateSetKeys: string[] | null;
  lastFilter: { id?: string; userId?: string };
} = {
  identities: [],
  lastUpdateSetKeys: null,
  lastFilter: {},
};

let filterAccum: { id?: string; userId?: string } = {};

vi.mock("drizzle-orm", () => ({
  eq: (col: { _colName: string }, val: unknown) => {
    if (col._colName === "userId") filterAccum.userId = val as string;
    else if (col._colName === "id") filterAccum.id = val as string;
    return { __type: "eq", col: col._colName, val };
  },
  and: (...conds: unknown[]) => ({ __type: "and", conds }),
}));

// Phase 129 Plan 129-02: identities.ts now imports getUsernameForUserId from
// host-user-counter.js (which transitively imports drizzle-orm's `inArray`
// and `isNotNull`, not mocked in this file). Stub both new modules so the
// PUT disk-write suite stays scoped to what it tests — the D-7 visibility
// gate applies to GET /, not PUT /, and has its own coverage in
// identities.get-disk.test.ts's "Phase 129: per-user visibility gate"
// describe block.
vi.mock("../../utils/host-user-counter.js", () => ({
  isHostMultiUser: vi.fn().mockResolvedValue(false),
  getUsernameForUserId: vi.fn().mockResolvedValue("test-user"),
}));

vi.mock("../../fleet-status/identity-visibility-gate.js", () => ({
  isIdentityVisibleToUser: () => true,
  resolveGateRoleSide: async () => null,
}));

// Phase 66 Plan 04: schema mock narrowed to 5 surviving columns.
vi.mock("../db/schema.js", () => ({
  identities: {
    id: { _colName: "id" },
    userId: { _colName: "userId" },
    identityKey: { _colName: "identityKey" },
    createdAt: { _colName: "createdAt" },
    updatedAt: { _colName: "updatedAt" },
  },
}));

vi.mock("../db/index.js", () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => {
      dbState.lastFilter = { ...filterAccum };
      filterAccum = {};
      return chain;
    },
    all: () => {
      const f = dbState.lastFilter;
      dbState.lastFilter = {};
      return dbState.identities.filter((r) => {
        if (f.userId !== undefined && r.userId !== f.userId) return false;
        if (f.id !== undefined && r.id !== f.id) return false;
        return true;
      });
    },
    insert: () => chain,
    values: () => chain,
    update: () => chain,
    set: (updates: Record<string, unknown>) => {
      dbState.lastUpdateSetKeys = Object.keys(updates);
      // Apply updates to the matching row (updatedAt bump is the visible mutation).
      const f = { ...filterAccum };
      for (const row of dbState.identities) {
        if (f.userId !== undefined && row.userId !== f.userId) continue;
        if (f.id !== undefined && row.id !== f.id) continue;
        Object.assign(row, updates);
      }
      return chain;
    },
    delete: () => chain,
    run: () => {
      filterAccum = {};
    },
  };
  return { db: chain };
});

vi.mock("../../utils/logger.js", () => ({
  databaseLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  sshLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// DatabaseSaveTrigger mock — Test 10 asserts forceSave("identity_updated")
// ---------------------------------------------------------------------------

const forceSaveMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: {
    forceSave: (reason: string) => forceSaveMock(reason),
  },
}));

// ---------------------------------------------------------------------------
// Artifact-reader mock — spies for read/write + isLocalHostId + MIME map
// ---------------------------------------------------------------------------

const readIdentityFileMock = vi.fn();
const writeIdentityFileMock = vi.fn();
const writeAvatarSiblingFileMock = vi.fn();
const isLocalHostIdMock = vi.fn();
const writeBinaryFileAtomicMock = vi.fn();
const submitAndFollowMock = vi.fn();
vi.mock("../../fleet-change/front-door.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fleet-change/front-door.js")>()),
  submitAndFollow: (...a: unknown[]) => submitAndFollowMock(...a),
}));

vi.mock("../../claude-session/identity-artifact-reader.js", () => ({
  stringifyColorHueForYaml: (obj: Record<string, unknown>) => (typeof obj.colorHue === "number" ? { ...obj, colorHue: String(obj.colorHue) } : obj),
  readIdentityFile: (
    conn: unknown,
    key: string,
  ) => readIdentityFileMock(conn, key),
  writeIdentityFile: (
    conn: unknown,
    key: string,
    body: string,
  ) => writeIdentityFileMock(conn, key, body),
  writeAvatarSiblingFile: (
    conn: unknown,
    key: string,
    ext: string,
    bytes: Buffer,
  ) => writeAvatarSiblingFileMock(conn, key, ext, bytes),
  isLocalHostId: (n: number | undefined) => isLocalHostIdMock(n),
  getLocalIdentitiesRoot: () => "/tmp/test-identities",
  writeBinaryFileAtomic: (conn: unknown, target: string, bytes: Buffer) => writeBinaryFileAtomicMock(conn, target, bytes),
  IDMEDIT_MAX_AVATAR_BYTES: 5_000_000,
  MIME_TO_AVATAR_EXT: {
    "image/webp": "webp",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
  },
  IDENTITY_KEY_RE: /^[a-z0-9_-]{1,64}$/,
  flowRolesInYamlDump: (yamlBody: string) => yamlBody,
  extractRolesFromMarkdown: (md: string): string[] => {
    const m = md.match(/^roles:\s*([a-z0-9-]+)\s*$/m);
    return m ? [m[1]] : [];
  },
  extractRoleFromMarkdown: (markdown: string): string | null => {
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    try {
      const parsed = yaml.load(match[1]) as Record<string, unknown> | null;
      if (parsed === null || typeof parsed !== "object") return null;
      // Mirrors the real reader: `roles:` only; exactly one role → it.
      const raw = parsed.roles;
      const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
      const names = list.map((r) => String(r).trim()).filter(Boolean);
      return names.length === 1 ? names[0] : null;
    } catch {
      return null;
    }
  },
  // Phase 67 /close 2026-09-01 follow-up (H1): the PUT handler now re-reads
  // disk cosmetics after write and overlays them onto publicIdentity so the
  // response echoes the true disk state (crucial for the coordinator flag).
  // Mirror the get-disk.test.ts mock: parse frontmatter and hoist only the
  // whitelist of cosmetic fields.
  // Identity pass-through: these fixtures carry well-formed frontmatter.
  repairFrontmatterTaskLine: (frontmatterRaw: string) => frontmatterRaw,
  extractCosmeticsFromFrontmatter: (markdown: string) => {
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    let parsed: unknown;
    try { parsed = yaml.load(match[1]); } catch { return {}; }
    if (parsed === null || typeof parsed !== "object") return {};
    const src = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof src.displayName === "string" && src.displayName.length > 0) out.displayName = src.displayName;
    if (typeof src.title === "string" && src.title.length > 0) out.title = src.title;
    // Mirror the real extractCosmeticsFromFrontmatter tolerance — accept
    // number OR numeric string (MDXEditor + Skynet writers now emit `'324'`).
    const rawHue = src.colorHue;
    const parsedHue =
      typeof rawHue === "number"
        ? rawHue
        : typeof rawHue === "string" && rawHue.trim() !== ""
          ? Number(rawHue)
          : Number.NaN;
    if (Number.isFinite(parsedHue) && parsedHue >= 0 && parsedHue <= 359) out.colorHue = parsedHue;
    if (typeof src.voice === "string" && src.voice.length > 0) out.voice = src.voice;
    if (typeof src.avatar === "string" && src.avatar.length > 0) out.avatar = src.avatar;
    if (typeof src.coordinator === "boolean") out.coordinator = src.coordinator;
    return out;
  },
}));

// ---------------------------------------------------------------------------
// SSH mocks — connectOneShot returns a fake conn; execCommand is a spy
// ---------------------------------------------------------------------------

const fakeConn = { __fake: "ssh-conn" } as unknown;
const connectOneShotMock = vi.fn();
const execCommandMock = vi.fn();

vi.mock("../../ssh/ssh-one-shot.js", () => ({
  connectOneShot: (host: unknown, timeoutMs: number) =>
    connectOneShotMock(host, timeoutMs),
}));

vi.mock("../../ssh/tmux-helper.js", () => ({
  execCommand: (conn: unknown, cmd: string) => execCommandMock(conn, cmd),
}));

// ---------------------------------------------------------------------------
// fs/promises mock — spy on unlink only; pass through real implementations
// for any other method (none used in this test file). The identities.ts
// handler imports `* as fs from "node:fs/promises"` so we mock under that
// same specifier.
//
// vi.hoisted() runs BEFORE module loading and before other vi.mock factories,
// making the spy safe to reference in both the factory and the test body.
// ---------------------------------------------------------------------------

const { fsUnlinkSpy } = vi.hoisted(() => ({ fsUnlinkSpy: vi.fn() }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    unlink: (...args: Parameters<typeof actual.unlink>) => fsUnlinkSpy(...args),
  };
});

vi.mock("../../ssh/host-resolver.js", () => ({
  resolveHostById: vi.fn().mockResolvedValue({
    ip: "10.0.0.5",
    port: 22,
    username: "ubuntu",
    authType: "key",
    key: "fake-key",
  }),
}));

// Also mock the fake `end()` since the PUT handler will call conn.end() in
// try/finally. Fake conn is a plain object — inject an end() when we return
// it from connectOneShot.
function makeFakeConnWithEnd(): { __fake: string; end: () => void } {
  return { __fake: "ssh-conn", end: vi.fn() };
}

// ---------------------------------------------------------------------------
// Import the router AFTER all mocks are installed
// ---------------------------------------------------------------------------

import identitiesRouter from "./identities.js";

// ---------------------------------------------------------------------------
// HTTP helper (multipart body construction for PUT /identities/:id)
// ---------------------------------------------------------------------------

const BOUNDARY = "----vitest66-02boundary";

function buildMultipartBody(opts: {
  data: unknown;
  file?: { filename: string; contentType: string; bytes: Buffer };
}): Buffer {
  const parts: Array<Buffer | string> = [];
  parts.push(`--${BOUNDARY}\r\n`);
  parts.push(`Content-Disposition: form-data; name="data"\r\n\r\n`);
  parts.push(JSON.stringify(opts.data));
  parts.push(`\r\n`);
  if (opts.file) {
    parts.push(`--${BOUNDARY}\r\n`);
    parts.push(
      `Content-Disposition: form-data; name="avatar"; filename="${opts.file.filename}"\r\n`,
    );
    parts.push(`Content-Type: ${opts.file.contentType}\r\n\r\n`);
    parts.push(opts.file.bytes);
    parts.push(`\r\n`);
  }
  parts.push(`--${BOUNDARY}--\r\n`);
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}

function httpPut(
  server: http.Server,
  path: string,
  body: Buffer,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "PUT",
        path,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let server: http.Server;

function seedRow(overrides: Partial<IdentityRow> = {}): IdentityRow {
  const row: IdentityRow = {
    id: "test-id",
    userId: "test-user",
    identityKey: "testkey",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUserId = "test-user";
  dbState.identities = [seedRow()];
  dbState.lastUpdateSetKeys = null;
  dbState.lastFilter = {};
  filterAccum = {};

  // Default mock behaviors — each test overrides as needed.
  readIdentityFileMock.mockResolvedValue({
    markdown:
      "---\nroles: box-maintainer\ndisplayName: Old\ntitle: Old T\ncolorHue: 90\n---\n\n# testkey\n",
  });
  writeIdentityFileMock.mockResolvedValue(undefined);
  writeAvatarSiblingFileMock.mockResolvedValue(undefined);
  isLocalHostIdMock.mockReturnValue(false); // REMOTE by default
  connectOneShotMock.mockResolvedValue(makeFakeConnWithEnd());
  execCommandMock.mockResolvedValue("");
  forceSaveMock.mockResolvedValue(undefined);
  fsUnlinkSpy.mockResolvedValue(undefined);
  writeBinaryFileAtomicMock.mockResolvedValue(undefined);
  submitAndFollowMock.mockImplementation(async (_c: unknown, _k: string, _a: unknown, o: { id: string }) => ({
    state: "done",
    id: o.id,
    seq: 1,
    result: { name: "testkey", changed: [] },
  }));

  const app = express();
  app.use("/identities", identitiesRouter);

  server = http.createServer(app);
  server.listen(0);
});

afterEach(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

// ===========================================================================
// Tests
// ===========================================================================

describe("PUT /identities/:identityKey — the change goes through the machine's front door", () => {
  function put(data: unknown, file?: { filename: string; contentType: string; bytes: Buffer }) {
    return httpPut(server, "/identities/testkey", buildMultipartBody({ data, ...(file ? { file } : {}) }));
  }
  function sentArgs(): Record<string, unknown> {
    return (submitAndFollowMock.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;
  }

  it("sends only the fields being set, with the click's request id; answers with the agent as it is now", async () => {
    readIdentityFileMock.mockResolvedValue({
      markdown: "---\nroles: box-maintainer\ndisplayName: Newname\ntitle: New Title\ncolorHue: '180'\n---\n\n# testkey\n",
    });
    const res = await put({ hostId: 7, displayName: "  Newname ", title: "New Title", colorHue: 180, task: "Ship: it", requestId: "edit-1" });
    expect(res.status).toBe(200);
    expect(submitAndFollowMock).toHaveBeenCalledWith(
      expect.objectContaining({ __fake: "ssh-conn" }),
      "agent-edit",
      { name: "testkey", set: { displayName: "Newname", title: "New Title", task: "Ship: it", colorHue: 180 }, unset: [] },
      { id: "edit-1", hostId: 7, totalS: 60 },
    );
    expect(res.body).toMatchObject({ displayName: "Newname", title: "New Title", colorHue: 180 });
    // The server never writes the file itself.
    expect(writeIdentityFileMock).not.toHaveBeenCalled();
  });

  it("explicit null removes a line; absent leaves it alone", async () => {
    await put({ hostId: 7, title: null, voice: null, colorHue: null, task: null });
    expect(sentArgs()).toEqual({ name: "testkey", set: {}, unset: ["title", "task", "voice", "colorHue"] });
  });

  it("a new picture is saved under a fresh name first, then put in place by the change", async () => {
    const res = await put(
      { hostId: 7, requestId: "pic-1" },
      { filename: "avatar.png", contentType: "image/png", bytes: Buffer.from("newpng") },
    );
    expect(res.status).toBe(200);
    expect(writeBinaryFileAtomicMock).toHaveBeenCalledTimes(1);
    const [, target, bytes] = writeBinaryFileAtomicMock.mock.calls[0];
    expect(target).toBe("$HOME/fleet/identities/testkey/.avatar-upload-pic-1.png");
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(sentArgs()).toMatchObject({ avatar: { upload: ".avatar-upload-pic-1.png", ext: "png" } });
    expect(writeBinaryFileAtomicMock.mock.invocationCallOrder[0]).toBeLessThan(submitAndFollowMock.mock.invocationCallOrder[0]);
  });

  it("avatar:null removes the picture (the machine drops the line and the file)", async () => {
    await put({ hostId: 7, avatar: null });
    expect(sentArgs()).toMatchObject({ unset: ["avatar"] });
  });

  it("a refusal (being archived, gone) is the machine's 409 with its reason", async () => {
    submitAndFollowMock.mockResolvedValue({ state: "refused", id: "x", seq: 1, code: "being_archived", reason: "it's being archived" });
    const res = await put({ hostId: 7, title: "T" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "being_archived", error: "it's being archived" });
    submitAndFollowMock.mockResolvedValue({ state: "refused", id: "x", seq: 1, code: "not_found", reason: "there's no agent 'testkey' on this machine" });
    expect((await put({ hostId: 7, title: "T" })).status).toBe(409);
  });

  it("still waiting after the follow-up → 202", async () => {
    submitAndFollowMock.mockResolvedValue({ state: "pending", id: "x", seq: 1, stage: "queued" });
    expect((await put({ hostId: 7, title: "T" })).status).toBe(202);
  });

  it("a machine still updating never took the picture: it's removed (REMOTE and LOCAL)", async () => {
    submitAndFollowMock.mockResolvedValue({ state: "not_installed", id: "x" });
    const file = { filename: "a.png", contentType: "image/png", bytes: Buffer.from("png") };
    const r = await put({ hostId: 7, requestId: "u1" }, file);
    expect(r.status).toBe(503);
    expect(execCommandMock).toHaveBeenCalledWith(expect.anything(), 'rm -f "$HOME/fleet/identities/testkey/.avatar-upload-u1.png"');
    isLocalHostIdMock.mockReturnValue(true);
    await put({ hostId: 5, requestId: "u2" }, file);
    expect(fsUnlinkSpy).toHaveBeenCalledWith("/tmp/test-identities/testkey/.avatar-upload-u2.png");
  });

  it("missing hostId → 400; an unreachable machine → 502", async () => {
    expect((await put({ title: "T" })).status).toBe(400);
    connectOneShotMock.mockRejectedValueOnce(new Error("refused"));
    const r = await put({ hostId: 7, title: "T" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: "identity home box unreachable" });
    expect(submitAndFollowMock).not.toHaveBeenCalled();
  });

  it("LOCAL: no SSH; the front door is reached through the bind mount (conn null)", async () => {
    isLocalHostIdMock.mockReturnValue(true);
    expect((await put({ hostId: 5, title: "T" })).status).toBe(200);
    expect(connectOneShotMock).not.toHaveBeenCalled();
    expect(submitAndFollowMock.mock.calls[0]?.[0]).toBeNull();
  });

  it("the answer echoes the disk after the change (coordinator included)", async () => {
    readIdentityFileMock.mockResolvedValue({
      markdown: "---\nroles: box-maintainer\ndisplayName: Coord\ncolorHue: 216\ncoordinator: true\n---\n\n# testkey\n",
    });
    const res = await put({ hostId: 7, title: "New Title" });
    expect(res.body).toMatchObject({ coordinator: true, displayName: "Coord", colorHue: 216 });
  });

  it("REMOTE PUT holds a per-host semaphore slot: 6 concurrent PUTs, cap 2 → ≤2 live conns", async () => {
    const { __resetHostSemaphoreRegistryForTests, getHostSemaphore } =
      await import("../../ssh/host-semaphore-registry.js");
    __resetHostSemaphoreRegistryForTests();
    getHostSemaphore(7, 2);
    let live = 0;
    let peak = 0;
    connectOneShotMock.mockImplementation(async () => {
      live++;
      peak = Math.max(peak, live);
      return { end: () => { live--; } };
    });
    submitAndFollowMock.mockImplementation(async (_c: unknown, _k: string, _a: unknown, o: { id: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      return { state: "done", id: o.id, seq: 1, result: {} };
    });
    const results = await Promise.all(Array.from({ length: 6 }, () => put({ hostId: 7, title: "T" })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
    expect(live).toBe(0);
    __resetHostSemaphoreRegistryForTests();
  });
});
