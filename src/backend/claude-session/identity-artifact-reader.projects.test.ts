/**
 * identity-artifact-reader.projects.test.ts — Phase 117 Plan 117-01
 *
 * Unit tests for the project primitives added to identity-artifact-reader.ts
 * per CONTEXT.md D-01..D-05, D-25, D-30, D-32, D-36:
 *
 *   Task 1 exports:
 *     - PROJECT_SLUG_RE = /^[a-z0-9-]{1,64}$/ constant
 *     - getLocalProjectsRoot(): string
 *     - readSessionProjectField(conn, identityKey): Promise<string | null>
 *     - writeSessionProjectField(conn, identityKey, projectSlug | null): Promise<void>
 *
 *   Task 2 exports (appended below):
 *     - listProjects(conn): Promise<Array<{slug, displayName}>>
 *     - readProjectFile(conn, slug): Promise<{markdown: string}>
 *     - createProject(conn, slug, displayName): Promise<void>
 *
 * The load-bearing constraint (RESEARCH § Common Pitfalls #5): the frontmatter
 * writer must go through a FULL yaml.load round-trip, NOT
 * extractCosmeticsFromFrontmatter (which is field-narrowing and drops unknown
 * keys). Test 12 (writeSessionProjectField unknown-key preservation) is the
 * regression guard.
 *
 * Mocking strategy follows identity-artifact-reader.avatar-read.test.ts:
 *   - vi.mock("fs/promises") — LOCAL branch reads/writes
 *   - vi.mock("../ssh/tmux-helper.js") — REMOTE-branch execCommand
 *   - mock ssh2 Client's .sftp() for writeMarkdownFileAtomic's REMOTE branch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import type { Client as SSHClientType } from "ssh2";
type SFTPWrapper = import("ssh2").SFTPWrapper;
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the dynamic import of identity-artifact-reader
// ---------------------------------------------------------------------------

const execCommandMock = vi.fn();
vi.mock("../ssh/tmux-helper.js", () => ({
  execCommand: (conn: unknown, cmd: string) => execCommandMock(conn, cmd),
}));

const fsReadFileMock = vi.fn();
const fsWriteFileMock = vi.fn();
const fsRenameMock = vi.fn();
const fsMkdirMock = vi.fn();
const fsReaddirMock = vi.fn();
const fsStatMock = vi.fn();
const fsUnlinkMock = vi.fn();

vi.mock("fs/promises", () => ({
  default: {
    readFile: (p: string, opts?: unknown) => fsReadFileMock(p, opts),
    writeFile: (p: string, data: unknown, opts?: unknown) =>
      fsWriteFileMock(p, data, opts),
    rename: (from: string, to: string) => fsRenameMock(from, to),
    mkdir: (p: string, opts?: unknown) => fsMkdirMock(p, opts),
    readdir: (p: string, opts?: unknown) => fsReaddirMock(p, opts),
    stat: (p: string) => fsStatMock(p),
    unlink: (p: string) => fsUnlinkMock(p),
  },
  readFile: (p: string, opts?: unknown) => fsReadFileMock(p, opts),
  writeFile: (p: string, data: unknown, opts?: unknown) =>
    fsWriteFileMock(p, data, opts),
  rename: (from: string, to: string) => fsRenameMock(from, to),
  mkdir: (p: string, opts?: unknown) => fsMkdirMock(p, opts),
  readdir: (p: string, opts?: unknown) => fsReaddirMock(p, opts),
  stat: (p: string) => fsStatMock(p),
  unlink: (p: string) => fsUnlinkMock(p),
}));

// Import AFTER the vi.mock so the mocks bind to the module graph.
import {
  PROJECT_SLUG_RE,
  getLocalProjectsRoot,
  readSessionProjectField,
  listProjects,
  LIST_PROJECTS_REMOTE_CMD,
  parseListProjectsBatchOutput,
  readProjectFile,
  writeProjectFile,
  applyProjectUsersBlock,
  projectMetaFromMarkdown,
} from "./identity-artifact-reader.js";

// ---------------------------------------------------------------------------
// Mock SSH client builder — records SFTP + exec activity for assertions
// ---------------------------------------------------------------------------

interface SftpCall {
  op: "writeFile" | "ext_openssh_rename" | "realpath";
  args: unknown[];
}

function buildMockConn(): {
  conn: SSHClientType;
  sftp: {
    writeFile: ReturnType<typeof vi.fn>;
    ext_openssh_rename: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    realpath: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  sftpCalls: SftpCall[];
} {
  const sftpCalls: SftpCall[] = [];

  const sftp = {
    writeFile: vi.fn(
      (
        p: string,
        buf: Buffer,
        opts: unknown,
        cb: (err: Error | undefined) => void,
      ) => {
        sftpCalls.push({ op: "writeFile", args: [p, buf, opts] });
        cb(undefined);
      },
    ),
    ext_openssh_rename: vi.fn(
      (from: string, to: string, cb: (err: Error | undefined) => void) => {
        sftpCalls.push({ op: "ext_openssh_rename", args: [from, to] });
        cb(undefined);
      },
    ),
    rename: vi.fn(() => {
      throw new Error("must not call sftp.rename — use ext_openssh_rename");
    }),
    unlink: vi.fn((_p: string, cb: (err: Error | undefined) => void) => {
      cb(undefined);
    }),
    realpath: vi.fn(
      (
        p: string,
        cb: (err: Error | undefined, absPath?: string) => void,
      ) => {
        sftpCalls.push({ op: "realpath", args: [p] });
        cb(undefined, "/home/tester");
      },
    ),
    end: vi.fn(),
  };

  const conn = {
    sftp: (cb: (err: Error | undefined, s: SFTPWrapper) => void) => {
      cb(undefined, sftp as unknown as SFTPWrapper);
    },
  } as unknown as SSHClientType;

  return { conn, sftp, sftpCalls };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: fs ops reject with ENOENT — every test overrides as needed.
  fsReadFileMock.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    return Promise.reject(err);
  });
  fsWriteFileMock.mockImplementation(() => Promise.resolve());
  fsRenameMock.mockImplementation(() => Promise.resolve());
  fsMkdirMock.mockImplementation(() => Promise.resolve());
  fsReaddirMock.mockImplementation(() => Promise.resolve([]));
  fsStatMock.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    return Promise.reject(err);
  });
  fsUnlinkMock.mockImplementation(() => Promise.resolve());
  execCommandMock.mockResolvedValue("");
  // Ensure PROJECTS_HOST_DIR is unset by default.
  delete process.env.PROJECTS_HOST_DIR;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PROJECTS_HOST_DIR;
});

// ===========================================================================
// Task 1: PROJECT_SLUG_RE + getLocalProjectsRoot + read/writeSessionProjectField
// ===========================================================================

describe("PROJECT_SLUG_RE (D-04 kebab-case-lowercased)", () => {
  it("Test 1: accepts abc, a-b-c, proj-1, 0-9, 64-char string; rejects 65-char, uppercase, underscore, slash, empty", () => {
    // Positive cases
    expect(PROJECT_SLUG_RE.test("abc")).toBe(true);
    expect(PROJECT_SLUG_RE.test("a-b-c")).toBe(true);
    expect(PROJECT_SLUG_RE.test("proj-1")).toBe(true);
    expect(PROJECT_SLUG_RE.test("0-9")).toBe(true);
    expect(PROJECT_SLUG_RE.test("a".repeat(64))).toBe(true);

    // Negative cases
    expect(PROJECT_SLUG_RE.test("a".repeat(65))).toBe(false);
    expect(PROJECT_SLUG_RE.test("A")).toBe(false); // uppercase rejected
    expect(PROJECT_SLUG_RE.test("abc_def")).toBe(false); // underscore rejected per D-04
    expect(PROJECT_SLUG_RE.test("abc/def")).toBe(false);
    expect(PROJECT_SLUG_RE.test("")).toBe(false);

    // Byte-shape gate on the regex literal itself: no `i` flag, no `_` in charset.
    expect(PROJECT_SLUG_RE.flags).toBe("");
    expect(PROJECT_SLUG_RE.source).toBe("^[a-z0-9-]{1,64}$");
  });
});

describe("getLocalProjectsRoot", () => {
  it("Test 2a: returns process.env.PROJECTS_HOST_DIR when set", () => {
    process.env.PROJECTS_HOST_DIR = "/tmp/x";
    expect(getLocalProjectsRoot()).toBe("/tmp/x");
  });

  it("Test 2b: falls back to os.homedir()/fleet/projects when env var unset", () => {
    delete process.env.PROJECTS_HOST_DIR;
    expect(getLocalProjectsRoot()).toBe(
      path.join(os.homedir(), "fleet", "projects"),
    );
  });
});

describe("readSessionProjectField", () => {
  it("Test 3: LOCAL happy — returns 'alpha' when frontmatter has project: alpha", async () => {
    fsReadFileMock.mockResolvedValueOnce(
      `---\nroles: worker\nproject: alpha\ndisplayName: 'W'\n---\nbody`,
    );
    const result = await readSessionProjectField(null, "moxie");
    expect(result).toBe("alpha");
  });

  it("Test 4: LOCAL missing key — returns null when frontmatter has no project key", async () => {
    fsReadFileMock.mockResolvedValueOnce(
      `---\nroles: worker\ndisplayName: 'W'\n---\nbody`,
    );
    const result = await readSessionProjectField(null, "moxie");
    expect(result).toBeNull();
  });

  it("Test 5: LOCAL no frontmatter — returns null when body has no --- fence", async () => {
    fsReadFileMock.mockResolvedValueOnce("just a body, no frontmatter at all");
    const result = await readSessionProjectField(null, "moxie");
    expect(result).toBeNull();
  });

  it("Test 6: LOCAL empty file (ENOENT) — returns null without throwing", async () => {
    // fsReadFileMock default is ENOENT-reject → readIdentityFile catches and
    // returns {markdown: ""} → readSessionProjectField sees empty markdown.
    const result = await readSessionProjectField(null, "moxie");
    expect(result).toBeNull();
  });

  it("Test 6b: LOCAL bogus YAML — returns null (graceful, does not throw)", async () => {
    fsReadFileMock.mockResolvedValueOnce(
      `---\nroles: worker\ntask: value with: unquoted-colon\n---\nbody`,
    );
    const result = await readSessionProjectField(null, "moxie");
    // js-yaml may or may not accept this shape — either way, project is absent.
    expect(result).toBeNull();
  });
});

// ===========================================================================
// Task 2: listProjects + readProjectFile + createProject
// ===========================================================================

/**
 * Helper: build a Dirent-shaped object for fs.readdir({withFileTypes:true})
 * mocks. Vitest doesn't include fs.Dirent so we duck-type it.
 */
function makeDirent(name: string, isDir: boolean): {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
} {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  };
}

describe("listProjects — LOCAL branch", () => {
  it("Test L1: happy — three dirs (alpha, beta, archive); archive EXCLUDED; sorted by slug; displayName pulled from each project.md", async () => {
    // fs.readdir on the root returns 3 dirents.
    fsReaddirMock.mockImplementation((p: string, opts?: unknown) => {
      const _ = opts;
      if (typeof p === "string" && p.endsWith("projects")) {
        return Promise.resolve([
          makeDirent("beta", true),
          makeDirent("alpha", true),
          makeDirent("archive", true),
        ]);
      }
      return Promise.resolve([]);
    });
    // Each project.md read returns the frontmatter shape.
    fsReadFileMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/alpha/project.md")) {
        return Promise.resolve("---\ndisplayName: 'Alpha One'\n---\n");
      }
      if (typeof p === "string" && p.includes("/beta/project.md")) {
        return Promise.resolve("---\ndisplayName: 'Beta'\n---\n");
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    const result = await listProjects(null);
    expect(result).toEqual([
      { slug: "alpha", displayName: "Alpha One", users: null, parent: null },
      { slug: "beta", displayName: "Beta", users: null, parent: null },
    ]);
    // archive MUST NOT appear anywhere.
    expect(result.some((p) => p.slug === "archive")).toBe(false);
  });

  it("Test L2: displayName fallback — falls back to slug when project.md missing or has no displayName", async () => {
    fsReaddirMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("projects")) {
        return Promise.resolve([
          makeDirent("alpha", true), // no project.md at all
          makeDirent("beta", true), // project.md exists but no displayName in frontmatter
        ]);
      }
      return Promise.resolve([]);
    });
    fsReadFileMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/alpha/project.md")) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      if (typeof p === "string" && p.includes("/beta/project.md")) {
        return Promise.resolve("---\nroles: something-else\n---\n");
      }
      return Promise.reject(new Error("unexpected path: " + p));
    });

    const result = await listProjects(null);
    expect(result).toEqual([
      { slug: "alpha", displayName: "alpha", users: null, parent: null },
      { slug: "beta", displayName: "beta", users: null, parent: null },
    ]);
  });

  it("Test L3: missing root — fs.readdir ENOENT → returns []", async () => {
    fsReaddirMock.mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    const result = await listProjects(null);
    expect(result).toEqual([]);
  });
});

const b64 = (t: string) => Buffer.from(t, "utf-8").toString("base64");
const rec = (slug: string, md: string | null) => `===PROJECT:${slug}===\n${md === null ? "" : b64(md)}\n`;

describe("listProjects — REMOTE branch (one batched exec)", () => {
  it("Test L4: happy — ONE exec (find ! -name archive + inline project.md); entries sorted; displayName parsed", async () => {
    const { conn } = buildMockConn();
    execCommandMock.mockResolvedValue(
      // NON-sorted order to prove sort happens client-side.
      rec("beta", "---\ndisplayName: 'Beta'\n---\n") +
        rec("alpha", "---\ndisplayName: 'Alpha One'\nusers: [alice]\n---\nbody\n"),
    );

    const result = await listProjects(conn);

    expect(execCommandMock).toHaveBeenCalledTimes(1);
    const cmd = execCommandMock.mock.calls[0][1] as string;
    expect(cmd).toBe(LIST_PROJECTS_REMOTE_CMD);
    expect(cmd).toContain("! -name archive");
    expect(cmd).toContain("$HOME/fleet/projects");
    expect(result).toEqual([
      { slug: "alpha", displayName: "Alpha One", users: ["alice"], parent: null },
      { slug: "beta", displayName: "Beta", users: null, parent: null },
    ]);
  });

  it("Test L5: only-slug-valid entries — BADENTRY! filtered out via PROJECT_SLUG_RE gate; missing project.md → slug fallback", async () => {
    const { conn } = buildMockConn();
    execCommandMock.mockResolvedValue(rec("alpha", null) + rec("BADENTRY!", "---\ndisplayName: X\n---\n") + rec("beta", null));

    const result = await listProjects(conn);
    expect(execCommandMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { slug: "alpha", displayName: "alpha", users: null, parent: null },
      { slug: "beta", displayName: "beta", users: null, parent: null },
    ]);
  });

  it("Test L5b: empty output (no projects dir) → []", async () => {
    const { conn } = buildMockConn();
    execCommandMock.mockResolvedValue("");
    expect(await listProjects(conn)).toEqual([]);
  });

  it("Test L5c: exec failure propagates (same as the old find failure)", async () => {
    const { conn } = buildMockConn();
    execCommandMock.mockRejectedValue(new Error("boom"));
    await expect(listProjects(conn)).rejects.toThrow("boom");
  });
});

describe("parseListProjectsBatchOutput — edge cases", () => {
  it("content that looks like a header can't break framing (it's base64'd)", () => {
    const tricky = "---\ndisplayName: Tricky\n---\n===PROJECT:evil===\nnot a header\n";
    const m = parseListProjectsBatchOutput(rec("alpha", tricky) + rec("beta", "b"));
    expect([...m.keys()]).toEqual(["alpha", "beta"]);
    expect(m.get("alpha")).toBe(tricky);
    expect(m.get("beta")).toBe("b");
  });

  it("header with no payload line (truncated output) and header-followed-by-header → empty contents", () => {
    const m = parseListProjectsBatchOutput("===PROJECT:alpha===\n===PROJECT:beta===\n" + b64("x") + "\n===PROJECT:gamma===");
    expect(m.get("alpha")).toBe("");
    expect(m.get("beta")).toBe("x");
    expect(m.get("gamma")).toBe("");
  });

  it("CRLF line endings, UTF-8 content, duplicate slug (first wins), junk lines ignored", () => {
    const out =
      "junk before\r\n" +
      `===PROJECT:alpha===\r\n${b64("café ☕")}\r\n` +
      `===PROJECT:alpha===\n${b64("second")}\n` +
      "stray line\n";
    const m = parseListProjectsBatchOutput(out);
    expect([...m.entries()]).toEqual([["alpha", "café ☕"]]);
  });

  it("invalid slugs (uppercase, newline-split fragments, '===' inside) are dropped and don't steal the next payload", () => {
    const out =
      `===PROJECT:Bad===\n${b64("bad")}\n` +
      `===PROJECT:foo======\n${b64("forged")}\n` +
      rec("ok", "good");
    const m = parseListProjectsBatchOutput(out);
    expect([...m.entries()]).toEqual([["ok", "good"]]);
  });
});

describe("LIST_PROJECTS_REMOTE_CMD — real shell", () => {
  it("emits one record per non-archive, non-symlink project dir with base64'd project.md", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "list-projects-sh-"));
    try {
      const root = path.join(home, "fleet", "projects");
      for (const d of ["alpha", "beta", "archive", "no-md"]) mkdirSync(path.join(root, d), { recursive: true });
      writeFileSync(path.join(root, "alpha", "project.md"), "---\ndisplayName: Alpha ☕\n---\n===PROJECT:beta===\n");
      writeFileSync(path.join(root, "beta", "project.md"), "");
      writeFileSync(path.join(root, "archive", "project.md"), "---\ndisplayName: Archived\n---\n");
      writeFileSync(path.join(root, "stray-file"), "x");
      symlinkSync(path.join(root, "alpha"), path.join(root, "linked"));
      const stdout = await new Promise<string>((resolve, reject) =>
        execFile("bash", ["-c", LIST_PROJECTS_REMOTE_CMD], { env: { ...process.env, HOME: home } }, (err, out) =>
          err ? reject(err) : resolve(out),
        ),
      );
      const m = parseListProjectsBatchOutput(stdout);
      expect([...m.keys()].sort()).toEqual(["alpha", "beta", "no-md"]);
      expect(m.get("alpha")).toBe("---\ndisplayName: Alpha ☕\n---\n===PROJECT:beta===\n");
      expect(m.get("beta")).toBe("");
      expect(m.get("no-md")).toBe("");

      // Missing projects dir → empty output, exit 0.
      const empty = await new Promise<string>((resolve, reject) =>
        execFile("bash", ["-c", LIST_PROJECTS_REMOTE_CMD], { env: { ...process.env, HOME: path.join(home, "nope") } }, (err, out) =>
          err ? reject(err) : resolve(out),
        ),
      );
      expect(empty).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 130: users-frontmatter parsing behavior in listProjects
//
// Mirrors the Phase 129 D-3 fallback discipline from identity-appearance.ts —
// an absent or malformed `users:` field surfaces as `users: null` on the
// listProjects row (falls open at the gate seam). A well-formed array of
// strings surfaces verbatim (case-preserved).
// ---------------------------------------------------------------------------
describe("listProjects — users frontmatter parsing (Phase 130 D-3)", () => {
  it("Test L6: users present as list of strings — surfaces verbatim (case preserved)", async () => {
    fsReaddirMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("projects")) {
        return Promise.resolve([makeDirent("alpha", true)]);
      }
      return Promise.resolve([]);
    });
    fsReadFileMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/alpha/project.md")) {
        // js-yaml renders inline flow-style arrays; assert case preservation
        // by writing mixed-case usernames.
        return Promise.resolve(
          "---\ndisplayName: 'Alpha'\nusers:\n  - Alice\n  - riley\n---\n",
        );
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    const result = await listProjects(null);
    expect(result).toEqual([
      { slug: "alpha", displayName: "Alpha", users: ["Alice", "riley"], parent: null },
    ]);
  });

  it("Test L7: users empty list — surfaces as null (falls open per D-3)", async () => {
    fsReaddirMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("projects")) {
        return Promise.resolve([makeDirent("alpha", true)]);
      }
      return Promise.resolve([]);
    });
    fsReadFileMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/alpha/project.md")) {
        return Promise.resolve(
          "---\ndisplayName: 'Alpha'\nusers: []\n---\n",
        );
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    // Empty list is structurally an array-of-strings that .every()-passes
    // trivially, so it DOES surface as []. The visibility gate itself is the
    // place that interprets empty-list-as-falls-open (matches
    // isIdentityVisibleToUser at identity-visibility-gate.ts:65-72). The
    // parser is intentionally faithful — round-tripping the file's bytes.
    const result = await listProjects(null);
    expect(result).toEqual([
      { slug: "alpha", displayName: "Alpha", users: [], parent: null },
    ]);
  });

  it("Test L8: users not an array — falls back to null (malformed value)", async () => {
    fsReaddirMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("projects")) {
        return Promise.resolve([makeDirent("alpha", true)]);
      }
      return Promise.resolve([]);
    });
    fsReadFileMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/alpha/project.md")) {
        // users: as a scalar (bad shape) — must NOT accidentally surface.
        return Promise.resolve(
          "---\ndisplayName: 'Alpha'\nusers: alice\n---\n",
        );
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    const result = await listProjects(null);
    expect(result).toEqual([
      { slug: "alpha", displayName: "Alpha", users: null, parent: null },
    ]);
  });

  it("Test L9: users array with non-string entries — falls back to null (mixed-type array)", async () => {
    fsReaddirMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("projects")) {
        return Promise.resolve([makeDirent("alpha", true)]);
      }
      return Promise.resolve([]);
    });
    fsReadFileMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/alpha/project.md")) {
        return Promise.resolve(
          "---\ndisplayName: 'Alpha'\nusers:\n  - alice\n  - 42\n---\n",
        );
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });

    const result = await listProjects(null);
    expect(result).toEqual([
      { slug: "alpha", displayName: "Alpha", users: null, parent: null },
    ]);
  });
});

describe("readProjectFile", () => {
  it("Test R1: LOCAL happy — returns {markdown: '...body'} from $HOME/fleet/projects/alpha/project.md", async () => {
    fsReadFileMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/alpha/project.md")) {
        return Promise.resolve("---\ndisplayName: 'Alpha'\n---\nbody");
      }
      return Promise.reject(new Error("unexpected: " + p));
    });

    const result = await readProjectFile(null, "alpha");
    expect(result).toEqual({ markdown: "---\ndisplayName: 'Alpha'\n---\nbody" });
  });

  it("Test R2: LOCAL missing — fs.readFile ENOENT → returns {markdown: ''}", async () => {
    // fsReadFileMock default is ENOENT-reject.
    const result = await readProjectFile(null, "alpha");
    expect(result).toEqual({ markdown: "" });
  });

  it("Test R3: invalid slug — 'Alpha' (uppercase) throws before any I/O", async () => {
    await expect(readProjectFile(null, "Alpha")).rejects.toThrow(
      /invalid project slug/,
    );
    expect(fsReadFileMock).not.toHaveBeenCalled();
  });
});

describe("writeProjectFile", () => {
  it("Test W1: LOCAL happy — writeMarkdownFileAtomic (writeFile+rename) hits $HOME/fleet/projects/alpha/project.md; server-echoes markdown", async () => {
    fsWriteFileMock.mockImplementation(() => Promise.resolve());
    fsRenameMock.mockImplementation(() => Promise.resolve());

    const contents = "---\ndisplayName: 'Alpha'\n---\nedited body";
    const result = await writeProjectFile(null, "alpha", contents);

    // Server-echo shape.
    expect(result).toEqual({ markdown: contents });

    // .tmp write then rename (writeMarkdownFileAtomic's atomic-write pattern).
    expect(fsWriteFileMock).toHaveBeenCalledTimes(1);
    const tmpPath = fsWriteFileMock.mock.calls[0][0] as string;
    expect(tmpPath.endsWith("/alpha/project.md.tmp")).toBe(true);
    const writtenBuf = fsWriteFileMock.mock.calls[0][1] as Buffer;
    expect(writtenBuf.toString("utf-8")).toBe(contents);

    expect(fsRenameMock).toHaveBeenCalledTimes(1);
    const renameFrom = fsRenameMock.mock.calls[0][0] as string;
    const renameTo = fsRenameMock.mock.calls[0][1] as string;
    expect(renameFrom.endsWith("/alpha/project.md.tmp")).toBe(true);
    expect(renameTo.endsWith("/alpha/project.md")).toBe(true);
    expect(renameTo).not.toContain(".tmp");
  });

  it("Test W2: LOCAL ENOENT on missing project dir — writeFile rejects, writeProjectFile propagates the error (no silent recovery)", async () => {
    const enoent = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    fsWriteFileMock.mockImplementation(() => Promise.reject(enoent));

    await expect(
      writeProjectFile(null, "alpha", "body"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Rename should NOT fire when the .tmp write itself failed.
    expect(fsRenameMock).not.toHaveBeenCalled();
  });

  it("Test W3: invalid slug — 'Alpha' (uppercase) throws before any I/O", async () => {
    await expect(writeProjectFile(null, "Alpha", "body")).rejects.toThrow(
      /invalid project slug/,
    );
    expect(fsWriteFileMock).not.toHaveBeenCalled();
    expect(fsRenameMock).not.toHaveBeenCalled();
  });

  it("Test W4: REMOTE happy — SFTP writeFile + ext_openssh_rename hit $HOME/fleet/projects/alpha/project.md; server-echoes markdown", async () => {
    const { conn, sftp } = buildMockConn();
    const contents = "---\ndisplayName: 'Alpha'\n---\nedited body";

    const result = await writeProjectFile(conn, "alpha", contents);
    expect(result).toEqual({ markdown: contents });

    // SFTP tmp+rename fired against the resolved $HOME/fleet/projects/... path.
    expect(sftp.writeFile).toHaveBeenCalledTimes(1);
    const writeTarget = sftp.writeFile.mock.calls[0][0] as string;
    expect(writeTarget.endsWith("/fleet/projects/alpha/project.md.tmp")).toBe(true);

    expect(sftp.ext_openssh_rename).toHaveBeenCalledTimes(1);
    const renameArgs = sftp.ext_openssh_rename.mock.calls[0];
    expect(renameArgs[0]).toBe("/home/tester/fleet/projects/alpha/project.md.tmp");
    expect(renameArgs[1]).toBe("/home/tester/fleet/projects/alpha/project.md");
  });
});

describe("listProjects — parent frontmatter (nested projects)", () => {
  function stubFiles(files: Record<string, string>) {
    fsReaddirMock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("projects")) {
        return Promise.resolve(Object.keys(files).map((n) => makeDirent(n, true)));
      }
      return Promise.resolve([]);
    });
    fsReadFileMock.mockImplementation((p: string) => {
      for (const [slug, body] of Object.entries(files)) {
        if (typeof p === "string" && p.includes(`/${slug}/project.md`)) {
          return Promise.resolve(body);
        }
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    });
  }

  it("valid slug surfaces; self, malformed, non-string, absent → null", async () => {
    stubFiles({
      kid: "---\ndisplayName: Kid\nparent: top\n---\n",
      quoted: "---\ndisplayName: Q\nparent: 'top'\n---\n",
      selfie: "---\nparent: selfie\n---\n",
      bad: "---\nparent: Not_A_Slug\n---\n",
      num: "---\nparent: 42\n---\n",
      top: "---\ndisplayName: Top\n---\n",
    });
    const result = await listProjects(null);
    expect(Object.fromEntries(result.map((r) => [r.slug, r.parent]))).toEqual({
      bad: null,
      kid: "top",
      num: null,
      quoted: "top",
      selfie: null,
      top: null,
    });
  });
});

describe("nested projects — review fixes (reader)", () => {
  it("a leading BOM doesn't hide the frontmatter", () => {
    const meta = projectMetaFromMarkdown(
      "kid",
      "\uFEFF---\ndisplayName: Kid\nusers: [alice]\nparent: top\n---\n",
    );
    expect(meta).toEqual({ slug: "kid", displayName: "Kid", users: ["alice"], parent: "top" });
  });

  it("applyProjectUsersBlock replaces flow or block users, keeping every other byte", () => {
    const flow = "---\ndisplayName: C\nparent: p\nusers: [x]\nmembers: []\n---\nbody\n";
    expect(applyProjectUsersBlock(flow, ["alice", "bob"])).toBe(
      "---\ndisplayName: C\nparent: p\nusers:\n  - alice\n  - bob\nmembers: []\n---\nbody\n",
    );
    const block = "---\ndisplayName: C\nusers:\n  - x\n\n  # c\n  - y\nmembers: []\n---\n";
    expect(applyProjectUsersBlock(block, ["alice"])).toBe(
      "---\ndisplayName: C\nusers:\n  - alice\nmembers: []\n---\n",
    );
  });

  it("applyProjectUsersBlock inserts after displayName/parent when absent; quotes odd names", () => {
    const md = "---\ndisplayName: C\nparent: p\nmembers:\n  - a1\n---\n";
    const out = applyProjectUsersBlock(md, ["ali ce"]);
    expect(out).toBe(
      '---\ndisplayName: C\nparent: p\nusers:\n  - "ali ce"\nmembers:\n  - a1\n---\n',
    );
    expect(projectMetaFromMarkdown("c", out).users).toEqual(["ali ce"]);
    expect(applyProjectUsersBlock("no frontmatter", ["a"])).toBe("no frontmatter");
  });
});
