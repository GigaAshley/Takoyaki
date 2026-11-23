/**
 * /instance-wide router — list instance-wide skills and roles with their sync
 * status, promote a host's skill/role to instance-wide, remove one, and nudge
 * a sync, and pick which machines each item goes to and which write back.
 * Editing an instance-wide skill's files goes through the skills editor with
 * hostId=0 (see instance-skill-files.ts).
 *
 * Admin-only for every mutation; anyone signed in may list.
 * Shape: .planning/shapes/shape-instance-wide-roles-and-skills.md
 */
import express from "express";
import { invocationFlagsOf } from "../../utils/skill-invocation.js";
import type { Request, Response } from "express";
import yaml from "js-yaml";
import { eq } from "drizzle-orm";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { resolveHostById } from "../../ssh/host-resolver.js";
import { systemLogger } from "../../utils/logger.js";
import { isItemKind, isValidItemName, type ItemKind, type ItemTargets } from "../../instance-wide/model.js";
import { PromoteError, type ItemMachines } from "../../instance-wide/engine.js";
import { callerIsAdmin } from "../../instance-wide/admin.js";
import {
  getInstanceWide,
  getMachines,
  machineForHostRow,
  syncedMachineForHostRow,
  type ProductionMachine,
} from "../../instance-wide/production.js";
import { isIdentityVisibleToUser } from "../../fleet-status/identity-visibility-gate.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

async function callerUsername(userId: string): Promise<string | null> {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  return rows[0]?.username ?? null;
}

function frontmatterOf(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  try {
    const parsed = yaml.load(m[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseTarget(body: Record<string, unknown>):
  | { kind: ItemKind; name: string }
  | null {
  const { kind, name } = body;
  if (!isItemKind(kind) || !isValidItemName(name)) return null;
  return { kind, name };
}

/**
 * `targets` ("all" or a list of machine ids) and `writeBack` (machine ids) from
 * a request body. Absent = every machine, no write-back. Returns a string on a
 * malformed body; the engine checks the ids themselves.
 */
function parseLists(body: Record<string, unknown>): ItemMachines | string {
  const ids = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && /^[0-9]{1,12}$/.test(x)) ? (v as string[]) : null;
  let targets: ItemTargets = "all";
  if (body.targets !== undefined && body.targets !== "all") {
    const list = ids(body.targets);
    if (!list) return "targets must be \"all\" or a list of machine ids";
    targets = list;
  }
  let writeBack: string[] = [];
  if (body.writeBack !== undefined) {
    const list = ids(body.writeBack);
    if (!list) return "writeBack must be a list of machine ids";
    writeBack = list;
  }
  return { targets, writeBack };
}

/** The machine whose synced home folder this host row reaches, for the caller. */
async function syncedMachineForCaller(hostId: number, userId: string): Promise<ProductionMachine | null> {
  return syncedMachineForHostRow(hostId, async () => {
    const row = await resolveHostById(hostId, userId);
    return row ? (row as { username?: unknown }).username : undefined;
  });
}

function sendPromoteError(res: Response, err: unknown): void {
  if (err instanceof PromoteError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "exists" || err.code === "reserved"
          ? 409
          : err.code === "too_large"
            ? 413
            : err.code === "unsafe" || err.code === "bad_machines"
              ? 400
              : 502;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  systemLogger.error("instance-wide route failed", {
    operation: "instance_wide_route_error",
    error: err instanceof Error ? err.message : "unknown",
  });
  if (!res.headersSent) res.status(500).json({ error: "internal" });
}

// ---------------------------------------------------------------------------
// GET /instance-wide/items?kind=skill|role[&hostId=<n>]
//
// With hostId: only the items that go to the machine that host row reaches
// (none when it reaches no synced home folder), each saying whether that
// machine writes it back.
// ---------------------------------------------------------------------------
router.get("/items", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const engine = getInstanceWide();
  if (!engine) {
    res.json({ isAdmin: await callerIsAdmin(userId), items: [] });
    return;
  }
  try {
    const kindFilter = isItemKind(req.query.kind) ? req.query.kind : null;
    const isAdmin = await callerIsAdmin(userId);
    const username = await callerUsername(userId);
    const rawHostId = req.query.hostId;
    let machineId: string | null | undefined;
    if (rawHostId !== undefined && rawHostId !== "") {
      const hostId = Number(rawHostId);
      if (!Number.isInteger(hostId) || hostId <= 0) {
        res.status(400).json({ error: "hostId must be a positive integer" });
        return;
      }
      // What goes to a machine is only for people who can reach it.
      if (!(await resolveHostById(hostId, userId))) {
        res.status(404).json({ error: "Host not found" });
        return;
      }
      machineId = (await syncedMachineForCaller(hostId, userId))?.machineId ?? null;
    }
    const items = [];
    for (const st of await engine.status()) {
      if (kindFilter && st.kind !== kindFilter) continue;
      const onMachine =
        machineId === undefined ? null : machineId !== null && (st.targets === "all" || st.targets.includes(machineId));
      if (onMachine === false) continue;
      const mainFile = st.kind === "skill" ? "SKILL.md" : `${st.name}.md`;
      let fm: Record<string, unknown> = {};
      try {
        fm = frontmatterOf((await engine.readMasterFile(st.kind, st.name, mainFile)).toString("utf-8"));
      } catch {
        fm = {};
      }
      if (st.kind === "role" && !isAdmin) {
        const visible = isIdentityVisibleToUser(
          null,
          { users: Array.isArray(fm.users) ? fm.users.map(String) : undefined },
          username,
        );
        if (!visible) continue;
      }
      const description =
        typeof fm.description === "string" ? fm.description.replace(/\s+/g, " ").trim() : undefined;
      const { targets, writeBack, ...rest } = st;
      items.push({
        ...rest,
        // Per-host detail (host names, errors) and the machine lists are for
        // admins; everyone else gets the counts only.
        hosts: isAdmin ? st.hosts : [],
        ...(isAdmin ? { targets, writeBack } : {}),
        ...(onMachine ? { writeBackHere: machineId !== null && writeBack.includes(machineId!) } : {}),
        description,
        ...(st.kind === "skill" ? invocationFlagsOf(fm) : {}),
        hostCount: await engine.hostCount(st.kind, st.name),
      });
    }
    systemLogger.debug("instance-wide items listed", {
      operation: "instance_wide_items_listed",
      kind: kindFilter ?? "all",
      hostId: rawHostId === undefined ? undefined : Number(rawHostId),
      machineId: machineId ?? undefined,
      count: items.length,
    });
    res.json({ isAdmin, items });
  } catch (err) {
    sendPromoteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /instance-wide/promote/preview  { kind, name, hostId }
// POST /instance-wide/promote          { kind, name, hostId }
// ---------------------------------------------------------------------------
async function resolvePromoteSource(req: Request, res: Response) {
  const userId = (req as AuthenticatedRequest).userId;
  if (!(await callerIsAdmin(userId))) {
    res.status(403).json({ error: "only admins can make things instance-wide" });
    return null;
  }
  const engine = getInstanceWide();
  if (!engine) {
    res.status(503).json({ error: "instance-wide sync is not running" });
    return null;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = parseTarget(body);
  const hostId = typeof body.hostId === "number" ? body.hostId : NaN;
  if (!target || !Number.isInteger(hostId) || hostId <= 0) {
    res.status(400).json({ error: "kind, name and hostId are required" });
    return null;
  }
  const lists = parseLists(body);
  if (typeof lists === "string") {
    res.status(400).json({ error: lists });
    return null;
  }
  if (!(await resolveHostById(hostId, userId))) {
    res.status(404).json({ error: "Host not found" });
    return null;
  }
  const machine = await machineForHostRow(hostId);
  if (!machine) {
    res.status(400).json({
      error: "this host does not receive the standard agent files, so it can't be a source",
    });
    return null;
  }
  return { engine, machine, lists, ...target };
}

router.post("/promote/preview", authenticateJWT, async (req: Request, res: Response) => {
  const src = await resolvePromoteSource(req, res);
  if (!src) return;
  try {
    if (await src.engine.isInstanceWide(src.kind, src.name)) {
      res.status(409).json({ error: `${src.kind} "${src.name}" is already instance-wide`, code: "exists" });
      return;
    }
    const size = await src.engine.inspectSource(src.kind, src.name, src.machine);
    const { clashes, unreachable } = await src.engine.findClashes(
      src.kind,
      src.name,
      src.machine.machineId,
      src.lists.targets,
    );
    res.json({ ...size, clashes, unreachable, sourceHostName: src.machine.hostName });
  } catch (err) {
    sendPromoteError(res, err);
  }
});

router.post("/promote", authenticateJWT, async (req: Request, res: Response) => {
  const src = await resolvePromoteSource(req, res);
  if (!src) return;
  try {
    const result = await src.engine.promote(src.kind, src.name, src.machine, src.lists);
    res.json(result);
  } catch (err) {
    sendPromoteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /instance-wide/items  { kind, name }
// ---------------------------------------------------------------------------
router.delete("/items", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  if (!(await callerIsAdmin(userId))) {
    res.status(403).json({ error: "only admins can remove instance-wide items" });
    return;
  }
  const engine = getInstanceWide();
  const target = parseTarget((req.body ?? {}) as Record<string, unknown>);
  if (!engine || !target) {
    res.status(engine ? 400 : 503).json({ error: engine ? "kind and name are required" : "not running" });
    return;
  }
  try {
    res.json(await engine.removeItem(target.kind, target.name));
  } catch (err) {
    sendPromoteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /instance-wide/machines — every fleet machine, for the machine lists (admin)
// ---------------------------------------------------------------------------
router.get("/machines", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  if (!(await callerIsAdmin(userId))) {
    res.status(403).json({ error: "admin only" });
    return;
  }
  const engine = getInstanceWide();
  if (!engine) {
    res.status(503).json({ error: "instance-wide sync is not running" });
    return;
  }
  try {
    const offline = await engine.offlineMachineIds();
    const machines = (await getMachines()).map((m) => ({
      machineId: m.machineId,
      hostName: m.hostName,
      hostRowIds: m.hostRowIds,
      offline: offline.has(m.machineId),
    }));
    res.json({ machines });
  } catch (err) {
    sendPromoteError(res, err);
  }
});

async function resolveListsChange(req: Request, res: Response, opts: { requireBoth: boolean }) {
  const userId = (req as AuthenticatedRequest).userId;
  if (!(await callerIsAdmin(userId))) {
    res.status(403).json({ error: "only admins can change where shared items go" });
    return null;
  }
  const engine = getInstanceWide();
  if (!engine) {
    res.status(503).json({ error: "instance-wide sync is not running" });
    return null;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = parseTarget(body);
  if (!target) {
    res.status(400).json({ error: "kind and name are required" });
    return null;
  }
  // Saving names both lists: a missing one must not quietly mean "every
  // machine" or "no write-back".
  if (opts.requireBoth && (body.targets === undefined || body.writeBack === undefined)) {
    res.status(400).json({ error: "targets and writeBack are both required" });
    return null;
  }
  const lists = parseLists(body);
  if (typeof lists === "string") {
    res.status(400).json({ error: lists });
    return null;
  }
  return { engine, lists, ...target };
}

// ---------------------------------------------------------------------------
// POST /instance-wide/machines/preview  { kind, name, targets }
// Same-named folders on the machines being added, before the change is saved.
// ---------------------------------------------------------------------------
router.post("/machines/preview", authenticateJWT, async (req: Request, res: Response) => {
  const change = await resolveListsChange(req, res, { requireBoth: false });
  if (!change) return;
  try {
    const current = await change.engine.machinesFor(change.kind, change.name);
    const all = (await getMachines()).map((m) => m.machineId);
    const inList = (t: ItemTargets, id: string) => t === "all" || t.includes(id);
    const added = all.filter((id) => inList(change.lists.targets, id) && !inList(current.targets, id));
    const { clashes, unreachable } =
      added.length > 0
        ? await change.engine.findClashes(change.kind, change.name, undefined, added)
        : { clashes: [], unreachable: [] };
    res.json({ clashes, unreachable });
  } catch (err) {
    sendPromoteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// PUT /instance-wide/machines  { kind, name, targets, writeBack }
// ---------------------------------------------------------------------------
router.put("/machines", authenticateJWT, async (req: Request, res: Response) => {
  const change = await resolveListsChange(req, res, { requireBoth: true });
  if (!change) return;
  try {
    const saved = await change.engine.setMachines(change.kind, change.name, change.lists);
    systemLogger.info("instance-wide machines saved", {
      operation: "instance_wide_machines_saved",
      userId: (req as AuthenticatedRequest).userId,
      item: `${change.kind}/${change.name}`,
      targets: saved.targets === "all" ? "all" : saved.targets.join(","),
      writeBack: saved.writeBack.join(","),
    });
    res.json(saved);
  } catch (err) {
    sendPromoteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /instance-wide/sync — run a sync pass soon (admin)
// ---------------------------------------------------------------------------
router.post("/sync", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  if (!(await callerIsAdmin(userId))) {
    res.status(403).json({ error: "admin only" });
    return;
  }
  getInstanceWide()?.requestSync();
  res.json({ ok: true });
});

export default router;
