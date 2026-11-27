/**
 * Phase 117 Plan 117-04: /projects router.
 *
 * Endpoints:
 *   GET  /projects?hostId=<n>              → enumerate non-archived projects
 *   POST /projects                          → create project (the machine's front door)
 *   POST /projects/:slug/archive            → archive it and everything in it (the machine's front door)
 *   POST /projects/:slug/parent             → nest under / un-nest a project (front door)
 *   POST /projects/:slug/rename             → change its name (front door)
 *   GET|PUT /projects/:slug/file            → raw project.md read / write
 *
 * Semantic contract (per Phase 117 CONTEXT):
 *   - D-11:  GET /projects returns
 *            { projects: [{slug, displayName, archived, parent}] }.
 *            Nested projects: `parent` is the raw parent slug (or null);
 *            visibility inherits down the tree (filterVisibleProjectTree).
 *            archive/ subdir is excluded upstream (listProjects primitive).
 *   - D-25:  POST body {hostId, displayName}. The server derives the base
 *            slug (derivePrettyNameSlug); the machine adds -2, -3, … until
 *            it's free.
 *   - D-28+D-30: POST /:slug/archive body {hostId} moves the whole project
 *            directory into `~/fleet/projects/archive/<slug>/`.
 *   - D-36a: JSON body throughout (small sentinel-drop-shaped payloads; no
 *            file uploads).
 *   - D-37:  Every successful write triggers `publishProjectListChanged`
 *            with the FULL current-projects array so connected clients
 *            receive the wire event (via subscription-registry singleton
 *            introduced by this plan).
 *
 * Byte-shape mirrors identity-archive.ts:76-159 (Phase 115) for JSON body
 * posture, hostId parse, JWT + resolveHostById gates, LOCAL/REMOTE branch on
 * isLocalHostId, try/catch/finally with connectOneShot, generic-500-with-
 * server-side-log.
 *
 * Security (Phase 117 Plan 117-04 threat register):
 *   - T-117-04-01 (EoP cross-user hostId probe): resolveHostById(hostId,
 *     userId) → 404 on cross-user or unknown host (NOT 403 — probe
 *     distinguisher defense).
 *   - T-117-04-02 (Tampering path-traversal via slug): PROJECT_SLUG_RE
 *     gate fires BEFORE any I/O on the archive route; POST create route
 *     derives the slug internally so cannot receive a hostile one.
 *   - T-117-04-05 (Info Disclosure via 500 body): fixed error shape
 *     `{error: "fixed string"}`; underlying err.message goes to
 *     databaseLogger.error only.
 *   - T-117-04-04 (DoS unauth flood): authenticateJWT gate on every route.
 *
 * Mounted at /projects in database.ts alongside /role-skills-editor.
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { databaseLogger } from "../../utils/logger.js";
import { resolveHostById } from "../../ssh/host-resolver.js";
import { connectOneShot } from "../../ssh/ssh-one-shot.js";
import {
  isLocalHostId,
  PROJECT_SLUG_RE,
  listProjects,
  readProjectFile,
  writeProjectFile,
  projectMetaFromMarkdown,
} from "../../claude-session/identity-artifact-reader.js";
import { getSubscriptionRegistry } from "../../fleet-status/subscription-registry.js";
// Phase 130: per-user visibility gate write side for projects. isHostMultiUser
// gates whether the auto-tag branch fires at all (single-user hosts stay silent
// per shape §"invisible in the majority case"); getUsernameForUserId resolves
// the JWT userId to a case-preserved Skynet username so the frontmatter
// `users:` list gets the human-readable name, not the opaque nanoid subject.
// Mirrors the Phase 129 roles-create.ts + identity-birth.ts pattern.
import {
  isHostMultiUser,
  getUsernameForUserId,
} from "../../utils/host-user-counter.js";
// Pretty-names shape: shared backend-authoritative slug derivation
// (replaces the per-endpoint normalizeToSlug). Spells out digits so a
// user-derived slug is pure [a-z-]+ and any digit in a slug on disk is
// unambiguously a system-appended collision marker.
import { derivePrettyNameSlug } from "../../utils/pretty-name-slug.js";
// Phase 130: per-user READ-side gate. Pure function; consumes the users list
// parsed from project.md frontmatter and returns visible/hidden per caller.
// Nested projects: the gate inherits down the parent tree — a project shows
// only if it and every ancestor present on the host pass.
import {
  filterVisibleProjectTree,
  redactHiddenParents,
} from "../../fleet-status/project-visibility-gate.js";
import { getHostSemaphore } from "../../ssh/host-semaphore-registry.js";
import { withHost } from "../../sharing/host-conn.js";
import {
  frontDoorHttp,
  frontDoorStatus,
  requestIdFrom,
  submitFrontDoor,
  type FrontDoorKind,
} from "../../fleet-change/front-door.js";
import { answerFromFrontDoor } from "../../fleet-change/front-door-route.js";
import { findProjectRooms, releaseProjectRooms } from "../../fleet-change/project-rooms.js";

/** What a project archive takes, as the machine reports it (fleet-change project-contents). */
interface ProjectContents {
  project: string;
  projects: Array<{ slug: string; displayName: string; parent: string | null }>;
  agents: Array<{ name: string; displayName: string; task: string; project: string }>;
  apps: Array<{ slug: string; title: string; project: string }>;
}

/** The lists the user confirmed: `{ projects, agents, apps }`, each of names. */
function parseExpectedContents(raw: unknown): { projects: string[]; agents: string[]; apps: string[] } | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const names = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length <= 2000 && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 128)
      ? (v as string[])
      : null;
  const projects = names(r.projects);
  const agents = names(r.agents);
  const apps = names(r.apps);
  return projects && agents && apps ? { projects, agents, apps } : null;
}

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

/** SSH connect timeout — matches sibling identity-archive.ts. */
const SSH_CONNECT_TIMEOUT_MS = 3000;

/**
 * Run a handler's SSH motion (connectOneShot + every exec/SFTP on that
 * connection + conn.end) under the shared per-host semaphore. One slot per
 * request: each handler drives its single connection serially, so a slot
 * bounds that request's channels. Local hosts touch the bind-mount with no
 * SSH channel and bypass the semaphore.
 */
function withHostSlot<T>(hostId: number, fn: () => Promise<T>): Promise<T> {
  return isLocalHostId(hostId) ? fn() : getHostSemaphore(hostId).run(fn);
}

/**
 * Per-host write lock for project-file edits that check the host's project
 * list and then write (the archive preflight, raw file save). Create, move and
 * rename go through the machine's front door instead, which takes them in turn. Held OUTSIDE withHostSlot, so lock waiters don't
 * occupy SSH slots. In-process only — every such write goes through this
 * backend.
 */
const projectWriteLocks = new Map<number, Promise<unknown>>();
function withProjectWriteLock<T>(hostId: number, fn: () => Promise<T>): Promise<T> {
  const prev = projectWriteLocks.get(hostId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  projectWriteLocks.set(hostId, tail);
  void tail.then(() => {
    if (projectWriteLocks.get(hostId) === tail) projectWriteLocks.delete(hostId);
  });
  return run;
}

/** displayName length cap — per plan behavior spec (1..80 chars). */
const DISPLAY_NAME_MAX_LEN = 80;

/**
 * Parse + validate a hostId value from either query params or body.
 *
 * Returns a positive integer or a { error } tuple describing the reason.
 */
interface ParsedHostOk {
  ok: true;
  hostId: number;
  error: null;
}
interface ParsedHostErr {
  ok: false;
  hostId: null;
  error: string;
}
type ParsedHost = ParsedHostOk | ParsedHostErr;

function parseHostId(raw: unknown): ParsedHost {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, hostId: null, error: "hostId is required" };
  }
  const hostId =
    typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(hostId) || hostId <= 0 || !Number.isInteger(hostId)) {
    return { ok: false, hostId: null, error: "hostId must be a positive integer" };
  }
  return { ok: true, hostId, error: null };
}

/**
 * Build the enriched wire-event payload from a listProjects result.
 *
 * Adds hostId (as string per wire-protocol schema), hostname (from the
 * resolved SSH host record), and archived:false (listProjects already
 * excludes the archive/ subdir per D-30). Non-archived only — v1 does
 * not surface archived projects on the wire.
 *
 * Phase 130: carries `users` on the internal ProjectListEntry so the
 * app-frame-filter's project-list-changed branch can apply the per-user
 * visibility gate against each subscriber before emit. The wire schema
 * `FrontendProjectListChangedFrameSchema` (wire-protocol.ts) deliberately
 * has NO users field — the filter STRIPS users before calling
 * makeProjectListChangedFrame, so the gate list never reaches subscribers.
 */
export function enrichForWire(
  projects: Array<{
    slug: string;
    displayName: string;
    users: string[] | null;
    parent: string | null;
  }>,
  hostId: number,
  hostname: string,
): Array<{
  slug: string;
  displayName: string;
  hostId: string;
  hostname: string;
  archived: boolean;
  users: string[] | null;
  parent: string | null;
}> {
  return projects.map((p) => ({
    slug: p.slug,
    displayName: p.displayName,
    hostId: String(hostId),
    hostname,
    archived: false,
    users: p.users,
    parent: p.parent,
  }));
}

/**
 * Nested projects: true iff `candidate` is `root` or sits somewhere beneath
 * it, following `parent` links over one host's project list. Cycle-safe —
 * a repeat stops the walk.
 */
function isSelfOrDescendant(
  projects: Array<{ slug: string; parent: string | null }>,
  candidate: string,
  root: string,
): boolean {
  const parentOf = new Map(projects.map((p) => [p.slug, p.parent]));
  const seen = new Set<string>();
  let node: string | null | undefined = candidate;
  while (typeof node === "string" && !seen.has(node)) {
    if (node === root) return true;
    seen.add(node);
    node = parentOf.get(node);
  }
  return false;
}

/**
 * Every project beneath `root` over one host's raw parent links (not `root`
 * itself). A project on a loop with `root` is not beneath it — the sidebar
 * draws loop members at top level.
 */
function descendantSlugs(
  projects: Array<{ slug: string; parent: string | null }>,
  root: string,
): string[] {
  const out: string[] = [];
  for (const p of projects) {
    if (p.slug === root) continue;
    if (isSelfOrDescendant(projects, root, p.slug)) continue; // loop with root
    if (isSelfOrDescendant(projects, p.slug, root)) out.push(p.slug);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /projects
// ---------------------------------------------------------------------------

router.get(
  "/",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthenticatedRequest).userId;

    // 1. Parse hostId (query param for GET).
    const parsed = parseHostId(req.query.hostId);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { hostId } = parsed;

    // 2. Verify host ownership — 404 on cross-user / unknown (T-117-04-01).
    const host = await resolveHostById(hostId, userId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }

    // Projects live on SSH hosts. RDP/VNC-only hosts have no shell to enumerate
    // ~/.claude/projects/ on, so short-circuit with an empty list rather than
    // paying a 60s SSH connect-timeout per call. Frontend host loops already
    // handle an empty projects array.
    if (host.enableSsh === false) {
      res.json({ projects: [] });
      return;
    }

    // 3. LOCAL vs REMOTE branch on isLocalHostId.
    // SSH work (connect + execs + conn.end) runs under the per-host
    // semaphore (verify:ssh-cap); local hosts bypass it.
    return withHostSlot(hostId, async () => {
      let conn: Awaited<ReturnType<typeof connectOneShot>> | null = null;
      if (!isLocalHostId(hostId)) {
        try {
          conn = await connectOneShot(
            host as unknown as Parameters<typeof connectOneShot>[0],
            SSH_CONNECT_TIMEOUT_MS,
          );
        } catch {
          res.status(504).json({ error: "Host unreachable" });
          return;
        }
      }

      try {
        const raw = await listProjects(conn);

        // Phase 130: per-user READ-side gate. Resolve caller's Skynet username
        // and drop any project the caller isn't gated to see. Fail-OPEN on
        // username-lookup failure (matches wave-2 identity-gate discipline at
        // starter.ts L685-697) — a null callerUsername is an infra bug, not
        // a gate signal; treating it as "hide everything" would empty every
        // user's projects sidebar on the affected code path.
        //
        // The `users` field is STRIPPED from the response body per Phase 129
        // HIGH-1 mirror: it's gate-only, MUST NOT leak to the client (no
        // evidence of cohabitants in a network trace).
        let callerUsername: string | null = null;
        try {
          callerUsername = await getUsernameForUserId(userId);
        } catch (usernameErr) {
          databaseLogger.warn(
            `projects-list: caller username lookup threw — gate disabled userId=${userId} hostId=${hostId}: ${usernameErr instanceof Error ? usernameErr.message : String(usernameErr)}`,
          );
        }

        const projects = redactHiddenParents(
          raw,
          filterVisibleProjectTree(raw, callerUsername),
        ).map((p) => ({
          slug: p.slug,
          displayName: p.displayName,
          archived: false,
          parent: p.parent,
        }));
        res.json({ projects });
        return;
      } catch (err) {
        databaseLogger.error(
          `failed to list projects hostId=${hostId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({ error: "failed to list projects" });
        return;
      } finally {
        if (conn) {
          try {
            conn.end();
          } catch {
            /* ignore */
          }
        }
      }
    });
  },
);

// ---------------------------------------------------------------------------
// POST /projects
// ---------------------------------------------------------------------------

/**
 * Slugs of the projects on this host the caller can see (tree-aware, same
 * gate as GET /). The write routes treat a project hidden from the caller as
 * absent, so nesting under — or moving — a hidden project answers exactly
 * like "not found" and never reveals it exists. A failed username lookup
 * falls open, matching GET /.
 */
async function visibleSlugsForCaller(
  projects: Array<{ slug: string; parent?: string | null; users: string[] | null }>,
  userId: string,
): Promise<Set<string>> {
  let callerUsername: string | null = null;
  try {
    callerUsername = await getUsernameForUserId(userId);
  } catch (err) {
    databaseLogger.warn(
      `projects: caller username lookup threw — visibility gate open for write userId=${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new Set(filterVisibleProjectTree(projects, callerUsername).map((p) => p.slug));
}


/** Who the visibility checks are for: the caller's username, or null (no gate) when it can't
 *  be looked up — the same fall-open as GET /. */
async function askerFor(userId: string): Promise<string | null> {
  try {
    return await getUsernameForUserId(userId);
  } catch (err) {
    databaseLogger.warn(
      `projects: caller username lookup threw — visibility gate open for write userId=${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * A project change through the machine's front door (create, rename, move): carried out in
 * turn with the machine's other changes, its checks made there and then. Once done, every
 * open tab gets the host's new project list.
 */
async function projectChange(
  req: Request,
  res: Response,
  opts: { hostId: number; kind: FrontDoorKind; args: Record<string, unknown>; operation: string },
): Promise<void> {
  const userId = (req as AuthenticatedRequest).userId;
  const host = await resolveHostById(opts.hostId, userId);
  if (!host) {
    res.status(404).json({ error: "Host not found" });
    return;
  }
  // Projects live on SSH hosts — see gate on GET / for rationale.
  if (host.enableSsh === false) {
    res.status(400).json({ error: "SSH is not enabled on this host" });
    return;
  }
  await answerFromFrontDoor(res, {
    hostId: opts.hostId,
    userId,
    kind: opts.kind,
    args: opts.args,
    requestId: requestIdFrom((req.body as { requestId?: unknown } | undefined)?.requestId),
    operation: opts.operation,
    onDone: async (conn) => {
      const registry = getSubscriptionRegistry();
      if (!registry) {
        databaseLogger.warn(
          `project-list-changed publish skipped: subscription registry not initialized (hostId=${opts.hostId} op=${opts.kind})`,
        );
        return;
      }
      const current = await listProjects(conn);
      registry.publishProjectListChanged(
        String(opts.hostId),
        enrichForWire(current, opts.hostId, host.name ?? String(opts.hostId)),
      );
    },
  });
}

/**
 * POST /projects  body { hostId, displayName, parent?, requestId? }
 *   → 200 { ok: true, requestId, result: { slug, displayName, parent, users } }
 *
 * The slug comes from the name here (letters and dashes); the machine picks the first free
 * one of base, base-2, base-3, … — a short name in use, archived, named as a parent or still
 * named by an agent is never reused. On a machine several people share, the project starts
 * shared with its creator (and, made inside a project, that project's people). A parent
 * hidden from the caller answers like one that doesn't exist (409 parent_not_found).
 */
router.post(
  "/",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthenticatedRequest).userId;
    const body = (req.body ?? {}) as { hostId?: unknown; displayName?: unknown; parent?: unknown };
    const parsedHost = parseHostId(body.hostId);
    if (!parsedHost.ok) {
      res.status(400).json({ error: parsedHost.error });
      return;
    }
    const { hostId } = parsedHost;
    const rawDN = body.displayName;
    if (typeof rawDN !== "string") {
      res.status(400).json({ error: "displayName is required" });
      return;
    }
    const derivation = derivePrettyNameSlug(rawDN);
    if (derivation.ok !== true) {
      const errorMsg =
        derivation.reason === "empty"
          ? "displayName is required"
          : derivation.reason === "too_long"
            ? `displayName must be ${DISPLAY_NAME_MAX_LEN} characters or fewer`
            : "displayName must contain at least one letter";
      res.status(400).json({ error: errorMsg });
      return;
    }
    if (/[\r\n]/.test(rawDN)) {
      res.status(400).json({ error: "displayName must be on one line" });
      return;
    }
    // Digits are spelled out, so a long name can make a long slug: cut it to leave room for
    // the machine's -2, -3, ….
    const baseSlug = derivation.slug.slice(0, 60).replace(/-+$/, "");
    let parent: string | null = null;
    if (body.parent !== undefined && body.parent !== null) {
      if (typeof body.parent !== "string" || !PROJECT_SLUG_RE.test(body.parent)) {
        res.status(400).json({ error: "parent must match [a-z0-9-]{1,64}" });
        return;
      }
      parent = body.parent;
    }
    let multiUser = false;
    try {
      multiUser = await isHostMultiUser(hostId);
    } catch (err) {
      // Never blocks the create: a wrongly-open project is fixable, a blocked create isn't.
      databaseLogger.warn(
        `projects-create: isHostMultiUser probe failed — no users list userId=${userId} hostId=${hostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await projectChange(req, res, {
      hostId,
      kind: "project-create",
      args: {
        baseSlug,
        displayName: rawDN.trim(),
        parent,
        asker: await askerFor(userId),
        multiUser,
      },
      operation: "project_create",
    });
  },
);

type ArchiveResult = { projects?: Array<{ slug: string }>; agents?: string[]; apps?: unknown[] };

/**
 * The server's part of a finished project archive: release the user's relay
 * rooms filed in the archived projects (from the chat server's own list) and
 * tell every open tab the host's project list changed. Safe to run twice.
 */
async function afterProjectArchive(
  conn: Awaited<ReturnType<typeof connectOneShot>> | null,
  hostId: number,
  hostName: string,
  userId: string,
  slug: string,
  result: ArchiveResult,
): Promise<Array<{ roomId: string; project: string }>> {
  const archivedSlugs = (result.projects ?? []).map((p) => p.slug);
  let rooms: Array<{ roomId: string; project: string }> = [];
  try {
    rooms = await releaseProjectRooms(userId, archivedSlugs);
  } catch (err) {
    databaseLogger.warn("project archive: couldn't release its relay rooms", {
      operation: "project_archive_rooms",
      userId,
      hostId,
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Post-write wire event (D-37) — rebuild the projects list (which now
  // excludes the just-archived slugs) and publish, scoped to this hostId. If
  // they were the LAST projects on this host, current is [] — a legitimate
  // per-host delta.
  try {
    const registry = getSubscriptionRegistry();
    if (registry) {
      const current = await listProjects(conn);
      registry.publishProjectListChanged(String(hostId), enrichForWire(current, hostId, hostName));
    } else {
      // Phase 117 M8 fix (2026-09-18): null-registry-at-request-time is a
      // startup-timing bug in production. Log a warning so the failure is
      // visible instead of dropping the WS fanout silently.
      databaseLogger.warn(
        `project-list-changed publish skipped: subscription registry not initialized (hostId=${hostId} slug=${slug} op=archive)`,
      );
    }
  } catch (publishErr) {
    databaseLogger.warn(
      `project-list-changed publish failed after archive hostId=${hostId} slug=${slug}: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}`,
    );
  }
  return rooms;
}

/** Archives the server is waiting on to finish, by `${hostId}:${requestId}`. */
const archivesBeingFinished = new Set<string>();
/** How long the server keeps asking about an archive still under way (15s waits). */
const FINISH_LATER_ROUNDS = 40;

/**
 * An archive still under way when its route answered: keep asking the machine
 * about it and do the server's part once it's done.
 */
function finishProjectArchiveLater(hostId: number, hostName: string, userId: string, slug: string, requestId: string): void {
  const key = `${hostId}:${requestId}`;
  if (archivesBeingFinished.has(key)) return;
  archivesBeingFinished.add(key);
  void (async () => {
    try {
      for (let round = 0; round < FINISH_LATER_ROUNDS; round++) {
        const finished = await withHost(hostId, userId, async (conn) => {
          const outcome = await frontDoorStatus(conn, requestId);
          if (outcome === null || outcome.state === "pending") return outcome === null ? "gone" : null;
          if (outcome.state === "done") {
            const rooms = await afterProjectArchive(conn, hostId, hostName, userId, slug, outcome.result as ArchiveResult);
            databaseLogger.info("project archived (finished after its request answered)", {
              operation: "project_archive",
              userId,
              hostId,
              slug,
              requestId,
              seq: outcome.seq,
              rooms: rooms.length,
              outcome: "archived_later",
            });
          } else {
            databaseLogger.info("project archive ended without archiving", {
              operation: "project_archive",
              userId,
              hostId,
              slug,
              requestId,
              outcome: outcome.state,
              code: "code" in outcome ? outcome.code : undefined,
            });
          }
          return outcome.state;
        });
        if (finished !== null) return;
      }
      databaseLogger.warn("project archive still under way after the server stopped waiting", {
        operation: "project_archive_finish_gave_up",
        hostId,
        slug,
        requestId,
      });
    } catch (err) {
      databaseLogger.warn("project archive: couldn't finish the server's part", {
        operation: "project_archive_finish_failed",
        hostId,
        slug,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      archivesBeingFinished.delete(key);
    }
  })();
}

// ---------------------------------------------------------------------------
// POST /projects/:slug/archive  body { hostId, expected, requestId? }
// ---------------------------------------------------------------------------
//
// Archives the project, every sub-project beneath it, their apps and agents,
// through the machine's front door (fleet-change project-archive): in
// arrival order with the machine's other changes, taking what the machine
// holds at that moment. `expected` is the { projects, agents, apps } lists
// the confirm showed (from archive-preflight); when the machine's contents no
// longer match it, nothing is archived and the answer is 409
// { code: "contents_changed", result: <current contents> } so the confirm can
// show the new list. The user's relay rooms filed in any of them go back to
// Conversations. → 200 { ok, requestId, result: { projects, agents, apps, rooms } };
// 202 still working; 503 machine still updating.

router.post(
  "/:slug/archive",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthenticatedRequest).userId;

    // 1. PROJECT_SLUG_RE gate BEFORE any I/O (T-117-04-02 path-traversal).
    const slug = String(req.params.slug ?? "");
    if (!slug || !PROJECT_SLUG_RE.test(slug)) {
      res
        .status(400)
        .json({ error: "slug must match [a-z0-9-]{1,64}" });
      return;
    }

    // 2. hostId gate, plus what the user confirmed and the request's id.
    const body = (req.body ?? {}) as { hostId?: unknown; expected?: unknown; requestId?: unknown };
    const parsedHost = parseHostId(body.hostId);
    if (!parsedHost.ok) {
      res.status(400).json({ error: parsedHost.error });
      return;
    }
    const { hostId } = parsedHost;
    const expected = parseExpectedContents(body.expected);
    if (expected === null) {
      res.status(400).json({ error: "expected must be { projects, agents, apps } — the lists the user confirmed" });
      return;
    }
    const requestId = requestIdFrom(body.requestId);

    // 3. Host ownership gate.
    const host = await resolveHostById(hostId, userId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }

    // Projects live on SSH hosts — see gate on GET / for rationale.
    if (host.enableSsh === false) {
      res.status(400).json({ error: "SSH is not enabled on this host" });
      return;
    }

    // 4. LOCAL/REMOTE branch.
    // SSH work (connect + execs + conn.end) runs under the per-host
    // semaphore (verify:ssh-cap); local hosts bypass it.
    return withProjectWriteLock(hostId, () => withHostSlot(hostId, async () => {
      let conn: Awaited<ReturnType<typeof connectOneShot>> | null = null;
      if (!isLocalHostId(hostId)) {
        try {
          conn = await connectOneShot(
            host as unknown as Parameters<typeof connectOneShot>[0],
            SSH_CONNECT_TIMEOUT_MS,
          );
        } catch {
          res.status(504).json({ error: "Host unreachable" });
          return;
        }
      }

      try {
        // The same request again (the client asking after "still working
        // on it"): the machine already has it, and the project may already
        // be gone — skip straight to its outcome.
        const known =
          typeof body.requestId === "string"
            ? await frontDoorStatus(conn, requestId, 0).catch(() => null)
            : null;
        // Archiving takes the whole subtree. Refuse when some of it is
        // hidden from the caller, rather than archive what they can't see.
        if (known === null) try {
          const current = await listProjects(conn);
          const visible = await visibleSlugsForCaller(current, userId);
          if (!current.some((p) => p.slug === slug) || !visible.has(slug)) {
            res.status(404).json({ error: "Project not found" });
            return;
          }
          const hidden = descendantSlugs(current, slug).filter((s) => !visible.has(s));
          if (hidden.length > 0) {
            databaseLogger.warn("project archive refused: sub-projects hidden from the caller", {
              operation: "project_archive",
              userId,
              hostId,
              slug,
              hiddenCount: hidden.length,
              outcome: "sub_projects_hidden",
            });
            res.status(409).json({
              error: "some sub-projects inside it are hidden from you",
              code: "sub_projects_hidden",
            });
            return;
          }
        } catch (err) {
          databaseLogger.error(
            `failed to list projects before archive hostId=${hostId} slug=${slug}: ${err instanceof Error ? err.message : String(err)}`,
          );
          res.status(500).json({ error: "failed to archive project" });
          return;
        }

        // The machine archives exactly what it holds now — refused when that
        // no longer matches the list the user confirmed.
        let outcome: Awaited<ReturnType<typeof submitFrontDoor>>;
        try {
          outcome = await submitFrontDoor(conn, "project-archive", { slug, expected }, { id: requestId, hostId });
        } catch (err) {
          databaseLogger.error(
            `failed to archive project hostId=${hostId} slug=${slug}: ${err instanceof Error ? err.message : String(err)}`,
          );
          res.status(500).json({ error: "failed to archive project" });
          return;
        }
        if (outcome.state === "refused" && outcome.code === "contents_changed") {
          // The new contents may include a sub-project this user can't see: refuse
          // instead of showing them what's in it.
          const now = (outcome.result as ProjectContents | undefined)?.projects ?? [];
          const visibleNow = await visibleSlugsForCaller(await listProjects(conn), userId);
          if (now.some((p) => !visibleNow.has(p.slug))) {
            res.status(409).json({ error: "some sub-projects inside it are hidden from you", code: "sub_projects_hidden" });
            return;
          }
        }
        if (outcome.state === "pending") {
          // The machine carries on with it; the server finishes its own part (rooms, other
          // devices) when it's done, whether or not this client asks again.
          finishProjectArchiveLater(hostId, host.name ?? String(hostId), userId, slug, requestId);
        }
        if (outcome.state !== "done") {
          databaseLogger.info("project archive not done", {
            operation: "project_archive",
            userId,
            hostId,
            slug,
            requestId,
            outcome: outcome.state,
            code: "code" in outcome ? outcome.code : undefined,
          });
          const { status, body: answer } = frontDoorHttp(outcome);
          res.status(status).json(answer);
          return;
        }
        const result = outcome.result as ArchiveResult;
        const archivedSlugs = (result.projects ?? []).map((p) => p.slug);
        const rooms = await afterProjectArchive(conn, hostId, host.name ?? String(hostId), userId, slug, result);

        databaseLogger.info("project archived", {
          operation: "project_archive",
          userId,
          hostId,
          slug,
          requestId,
          seq: outcome.seq,
          projects: archivedSlugs.length,
          agents: result.agents?.length ?? 0,
          apps: result.apps?.length ?? 0,
          rooms: rooms.length,
          outcome: "archived",
        });
        res.json({ ok: true, requestId, result: { ...result, rooms } });
        return;
      } finally {
        if (conn) {
          try {
            conn.end();
          } catch {
            /* ignore */
          }
        }
      }
    }));
  },
);

const MOVE_INTO_SELF_ERROR =
  "cannot move a project inside itself or its own sub-project";

// ---------------------------------------------------------------------------
// POST /projects/:slug/parent  body { hostId, parent: string | null, requestId? }
// POST /projects/:slug/rename  body { hostId, displayName, requestId? }
// ---------------------------------------------------------------------------
//
// Through the machine's front door, each changing only its own line of project.md, read
// when its turn comes.
//
// parent: nest a project under another on the same host, or back to top level (null). The
// folder never moves; the subtree follows because children name this project by slug.
// Refused (409) when the project is hidden from the caller or gone (not_found), the parent
// is (parent_not_found), or the parent is the project itself or beneath it (into_itself).
// A move that would let more people see the project keeps its current audience in its own
// users: list.
//
// rename: the displayName line only (the slug and folder stay).

router.post(
  "/:slug/parent",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const slug = String(req.params.slug ?? "");
    if (!slug || !PROJECT_SLUG_RE.test(slug)) {
      res.status(400).json({ error: "slug must match [a-z0-9-]{1,64}" });
      return;
    }
    const body = (req.body ?? {}) as { hostId?: unknown; parent?: unknown };
    const parsedHost = parseHostId(body.hostId);
    if (!parsedHost.ok) {
      res.status(400).json({ error: parsedHost.error });
      return;
    }
    const parent: string | null =
      typeof body.parent === "string" && PROJECT_SLUG_RE.test(body.parent) ? body.parent : null;
    if (body.parent !== null && parent === null) {
      res.status(400).json({ error: "parent must be null or match [a-z0-9-]{1,64}" });
      return;
    }
    await projectChange(req, res, {
      hostId: parsedHost.hostId,
      kind: "project-move",
      args: { slug, parent, asker: await askerFor((req as AuthenticatedRequest).userId) },
      operation: "project_set_parent",
    });
  },
);

router.post(
  "/:slug/rename",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const slug = String(req.params.slug ?? "");
    if (!slug || !PROJECT_SLUG_RE.test(slug)) {
      res.status(400).json({ error: "slug must match [a-z0-9-]{1,64}" });
      return;
    }
    const body = (req.body ?? {}) as { hostId?: unknown; displayName?: unknown };
    const parsedHost = parseHostId(body.hostId);
    if (!parsedHost.ok) {
      res.status(400).json({ error: parsedHost.error });
      return;
    }
    const name = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!name || name.length > DISPLAY_NAME_MAX_LEN || /[\r\n]/.test(name)) {
      res.status(400).json({ error: `displayName must be 1-${DISPLAY_NAME_MAX_LEN} characters on one line` });
      return;
    }
    await projectChange(req, res, {
      hostId: parsedHost.hostId,
      kind: "project-rename",
      args: { slug, displayName: name, asker: await askerFor((req as AuthenticatedRequest).userId) },
      operation: "project_rename",
    });
  },
);

// ---------------------------------------------------------------------------
// GET /projects/:slug/file  →  { markdown: string }
// PUT /projects/:slug/file  body { hostId, contents }  →  { markdown: string }
// ---------------------------------------------------------------------------
//
// Byte-shape mirror of the sibling routes above: authenticateJWT + parseHostId
// + resolveHostById + LOCAL/REMOTE branch + generic-500. Underlying primitives
// are readProjectFile / writeProjectFile in identity-artifact-reader.ts.
//
// Security:
//   - PROJECT_SLUG_RE gate BEFORE any I/O (T-117-04-02 path-traversal defense —
//     `.` / `/` outside the charset).
//   - resolveHostById 404 on cross-user / unknown (T-117-04-01 EoP defense).
//   - Fixed 500 shape (T-117-04-05 info-disclosure defense).
//   - authenticateJWT on both routes (T-117-04-04 unauth flood).

// ---------------------------------------------------------------------------
// GET /projects/:slug/archive-preflight?hostId=<n>
//   →  { hiddenSubProjects, contents, rooms, roomsUnknown }
// ---------------------------------------------------------------------------
//
// What archiving the project would take, as the machine sees it: asked
// through the front door (fleet-change project-contents), so it waits its
// turn behind moves just clicked and sees their result. `hiddenSubProjects`
// counts sub-projects hidden from the caller (the confirm refuses up front
// when it's not 0); `rooms` are the caller's relay rooms filed in any of
// them, from the chat server (`roomsUnknown` when it couldn't be asked).
// A project hidden from the caller answers "not found", like the move route.
router.get(
  "/:slug/archive-preflight",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthenticatedRequest).userId;

    const slug = String(req.params.slug ?? "");
    if (!slug || !PROJECT_SLUG_RE.test(slug)) {
      res.status(400).json({ error: "slug must match [a-z0-9-]{1,64}" });
      return;
    }

    const parsed = parseHostId(req.query.hostId);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { hostId } = parsed;

    const host = await resolveHostById(hostId, userId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }

    // Projects live on SSH hosts — see gate on GET / for rationale.
    if (host.enableSsh === false) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // SSH work (connect + execs + conn.end) runs under the per-host
    // semaphore (verify:ssh-cap); local hosts bypass it.
    return withHostSlot(hostId, async () => {
      let conn: Awaited<ReturnType<typeof connectOneShot>> | null = null;
      if (!isLocalHostId(hostId)) {
        try {
          conn = await connectOneShot(
            host as unknown as Parameters<typeof connectOneShot>[0],
            SSH_CONNECT_TIMEOUT_MS,
          );
        } catch {
          res.status(504).json({ error: "Host unreachable" });
          return;
        }
      }

      try {
        const current = await listProjects(conn);
        const visible = await visibleSlugsForCaller(current, userId);
        if (!current.some((p) => p.slug === slug) || !visible.has(slug)) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        const hiddenSubProjects = descendantSlugs(current, slug).filter(
          (s) => !visible.has(s),
        ).length;
        if (hiddenSubProjects > 0) {
          // Refused up front; what's inside isn't this user's to see.
          res.json({ hiddenSubProjects, contents: null, rooms: [], roomsUnknown: false });
          return;
        }
        const outcome = await submitFrontDoor(conn, "project-contents", { slug }, { hostId });
        if (outcome.state === "refused" && outcome.code === "not_found") {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        if (outcome.state !== "done") {
          const { status, body } = frontDoorHttp(outcome);
          res.status(status).json(body);
          return;
        }
        const contents = outcome.result as ProjectContents;
        const rooms = await findProjectRooms(userId, contents.projects.map((p) => p.slug));
        databaseLogger.info("project archive preflight", {
          operation: "project_archive_preflight",
          userId,
          hostId,
          slug,
          hiddenSubProjects,
          projects: contents.projects.length,
          agents: contents.agents.length,
          apps: contents.apps.length,
          rooms: rooms?.length ?? null,
        });
        res.json({ hiddenSubProjects, contents, rooms: rooms ?? [], roomsUnknown: rooms === null });
        return;
      } catch (err) {
        databaseLogger.error(
          `failed archive preflight hostId=${hostId} slug=${slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({ error: "failed to check project" });
        return;
      } finally {
        if (conn) {
          try {
            conn.end();
          } catch {
            /* ignore */
          }
        }
      }
    });
  },
);

router.get(
  "/:slug/file",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthenticatedRequest).userId;

    const slug = String(req.params.slug ?? "");
    if (!slug || !PROJECT_SLUG_RE.test(slug)) {
      res.status(400).json({ error: "slug must match [a-z0-9-]{1,64}" });
      return;
    }

    const parsed = parseHostId(req.query.hostId);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { hostId } = parsed;

    const host = await resolveHostById(hostId, userId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }

    // Projects live on SSH hosts — see gate on GET / for rationale.
    if (host.enableSsh === false) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // SSH work (connect + execs + conn.end) runs under the per-host
    // semaphore (verify:ssh-cap); local hosts bypass it.
    return withHostSlot(hostId, async () => {
      let conn: Awaited<ReturnType<typeof connectOneShot>> | null = null;
      if (!isLocalHostId(hostId)) {
        try {
          conn = await connectOneShot(
            host as unknown as Parameters<typeof connectOneShot>[0],
            SSH_CONNECT_TIMEOUT_MS,
          );
        } catch {
          res.status(504).json({ error: "Host unreachable" });
          return;
        }
      }

      try {
        const { markdown } = await readProjectFile(conn, slug);
        res.json({ markdown });
        return;
      } catch (err) {
        databaseLogger.error(
          `failed to read project file hostId=${hostId} slug=${slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({ error: "failed to read project file" });
        return;
      } finally {
        if (conn) {
          try {
            conn.end();
          } catch {
            /* ignore */
          }
        }
      }
    });
  },
);

router.put(
  "/:slug/file",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthenticatedRequest).userId;

    const slug = String(req.params.slug ?? "");
    if (!slug || !PROJECT_SLUG_RE.test(slug)) {
      res.status(400).json({ error: "slug must match [a-z0-9-]{1,64}" });
      return;
    }

    const body = (req.body ?? {}) as {
      hostId?: unknown;
      contents?: unknown;
    };

    const parsedHost = parseHostId(body.hostId);
    if (!parsedHost.ok) {
      res.status(400).json({ error: parsedHost.error });
      return;
    }
    const { hostId } = parsedHost;

    if (typeof body.contents !== "string") {
      res.status(400).json({ error: "contents is required" });
      return;
    }
    const contents = body.contents;

    const host = await resolveHostById(hostId, userId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }

    // Projects live on SSH hosts — see gate on GET / for rationale.
    if (host.enableSsh === false) {
      res.status(400).json({ error: "SSH is not enabled on this host" });
      return;
    }

    // SSH work (connect + execs + conn.end) runs under the per-host
    // semaphore (verify:ssh-cap); local hosts bypass it.
    return withProjectWriteLock(hostId, () => withHostSlot(hostId, async () => {
      let conn: Awaited<ReturnType<typeof connectOneShot>> | null = null;
      if (!isLocalHostId(hostId)) {
        try {
          conn = await connectOneShot(
            host as unknown as Parameters<typeof connectOneShot>[0],
            SSH_CONNECT_TIMEOUT_MS,
          );
        } catch {
          res.status(504).json({ error: "Host unreachable" });
          return;
        }
      }

      try {
        // Nested projects: a raw save that changes the `parent:` line gets
        // the same guard rails as a move — the parent must exist, be visible
        // to the caller, and not be the project itself or one of its own
        // sub-projects (a loop could otherwise expose a restricted project).
        const nextParent = projectMetaFromMarkdown(slug, contents).parent;
        if (nextParent !== null) {
          const { markdown: prevMarkdown } = await readProjectFile(conn, slug);
          if (projectMetaFromMarkdown(slug, prevMarkdown).parent !== nextParent) {
            const current = await listProjects(conn);
            const visible = await visibleSlugsForCaller(current, userId);
            const reject = (status: number, error: string, outcome: string) => {
              databaseLogger.warn("project file parent rejected", {
                operation: "project_file_parent",
                userId,
                hostId,
                slug,
                parent: nextParent,
                outcome,
              });
              res.status(status).json({ error });
            };
            if (!current.some((p) => p.slug === nextParent) || !visible.has(nextParent)) {
              reject(400, "parent project not found", "parent_not_found");
              return;
            }
            if (isSelfOrDescendant(current, nextParent, slug)) {
              reject(409, MOVE_INTO_SELF_ERROR, "rejected_descendant");
              return;
            }
          }
        }

        const { markdown } = await writeProjectFile(conn, slug, contents);
        databaseLogger.info(
          `project file written: userId=${userId} hostId=${hostId} slug=${slug} bytes=${contents.length}`,
        );

        // Post-write wire event (D-37 mirror): a project.md edit can change
        // the displayName in the frontmatter, so the sidebar's project
        // section headers must re-render across all connected clients. Mirror
        // the POST create + POST archive publish shape verbatim so the wire
        // frame looks identical no matter which write path fired it. Publish
        // failure MUST NOT roll back the file write — log and continue.
        try {
          const registry = getSubscriptionRegistry();
          if (registry) {
            const current = await listProjects(conn);
            registry.publishProjectListChanged(
              String(hostId),
              enrichForWire(current, hostId, host.name ?? String(hostId)),
            );
          } else {
            databaseLogger.warn(
              `project-list-changed publish skipped: subscription registry not initialized (hostId=${hostId} slug=${slug} op=write-file)`,
            );
          }
        } catch (publishErr) {
          databaseLogger.warn(
            `project-list-changed publish failed after write-file hostId=${hostId} slug=${slug}: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}`,
          );
        }

        res.json({ markdown });
        return;
      } catch (err) {
        databaseLogger.error(
          `failed to write project file hostId=${hostId} slug=${slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({ error: "failed to write project file" });
        return;
      } finally {
        if (conn) {
          try {
            conn.end();
          } catch {
            /* ignore */
          }
        }
      }
    }));
  },
);

// Generic 500 fallback error handler (mirrors sibling routes).
router.use(
  (
    err: Error,
    _req: Request,
    res: Response,
    _next: express.NextFunction,
  ) => {
    return res
      .status(500)
      .json({ error: err?.message ?? "project-list route error" });
  },
);

export default router;
