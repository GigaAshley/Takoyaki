/**
 * agent-services/admin/routes.ts — Admin → Services. Mounted on the /users
 * router; every route is admin-only.
 *
 *   GET    /users/admin/services                                   every service and its state
 *   GET    /users/admin/services/:service                          one service in full
 *   PUT    /users/admin/services/:service/keys/:name               { value }
 *   DELETE /users/admin/services/:service/keys/:name
 *   PUT    /users/admin/services/:service/settings/:name           { value } ("" = back to default)
 *   PUT    /users/admin/services/:service/machines/:machineId      { enabled }
 *   PUT    /users/admin/services/:service/people/:userId/keys/:name   { value }
 *   DELETE /users/admin/services/:service/people/:userId/keys/:name
 *
 * Write-only: no response ever carries a key value, to admins either. A
 * machine switch re-sweeps hosts, so the service's skill and helper arrive
 * on (or leave) the machine within a minute.
 */

import type { Request, RequestHandler, Response, Router } from "express";
import { eq } from "drizzle-orm";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { getDb } from "../../database/db/index.js";
import { users } from "../../database/db/schema.js";
import { systemLogger } from "../../utils/logger.js";
import type { ServiceDefinition } from "../engine/types.js";
import { AGENT_SERVICES } from "../registry.js";
import { hostReach } from "./reachability.js";
import { listAgentMachines } from "./machines.js";
import { servicesUpgradeFinished } from "./upgrade.js";
import {
  clearUserSecret,
  listServiceUserSecretStatus,
  setUserSecret,
} from "../user-secrets/store.js";
import { getSubstrateOrchestrator } from "../../distributor/substrate-orchestrator-singleton.js";
import { getKeyStore } from "./key-store.js";
import { clearSetting, effectiveSettings, setSetting, storedSettings } from "./settings-store.js";
import { enabledMachines, setEnabled } from "./grants.js";
import { serviceHealth, usageSummary } from "./usage.js";
import {
  listServices,
  serviceDetail,
  type AgentMachine,
  type OverviewDeps,
} from "./overview.js";

/** Longest key accepted. Generous for tokens; stops accidental pastes of whole files. */
export const MAX_KEY_LENGTH = 8192;

export interface ServicesRouteDeps extends OverviewDeps {
  services(): readonly ServiceDefinition[];
  /** Resolves once the one-time import has run; changes wait for it. */
  ready(): Promise<void>;
  setSetting(service: string, name: string, value: string, by: string): Promise<void>;
  clearSetting(service: string, name: string): Promise<void>;
  setEnabled(service: string, machineId: string, enabled: boolean, by: string): Promise<boolean>;
  /** Push or withdraw skills after a switch changed. */
  resweep(reason: string): void;
  userExists(userId: string): Promise<boolean>;
  setPersonKey(userId: string, service: string, name: string, value: string, by: string): Promise<void>;
  clearPersonKey(userId: string, service: string, name: string): Promise<boolean>;
}

/** How long a change waits for start-up to finish before giving up. */
const READY_WAIT_MS = 30_000;

/** One re-push for a burst of switch changes (an admin flipping several). */
const RESWEEP_DEBOUNCE_MS = 3_000;
function debounceResweep(fn: (reason: string) => void): (reason: string) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reasons = new Set<string>();
  return (reason) => {
    reasons.add(reason);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const all = [...reasons].join("; ");
      reasons.clear();
      fn(all);
    }, RESWEEP_DEBOUNCE_MS);
  };
}

export const defaultServicesRouteDeps: ServicesRouteDeps = {
  services: () => AGENT_SERVICES,
  get keyStore() {
    return getKeyStore();
  },
  effectiveSettings,
  storedSettings,
  enabledMachines,
  listAgentMachines,
  serviceHealth: (s) => serviceHealth(s),
  usageSummary: (s) => usageSummary(s),
  hostReach,
  ready: () => servicesUpgradeFinished,
  async listUsers() {
    return getDb().select({ id: users.id, username: users.username }).from(users);
  },
  listPersonKeyStatus: listServiceUserSecretStatus,
  setSetting,
  clearSetting,
  setEnabled,
  resweep: debounceResweep((reason) => void getSubstrateOrchestrator()?.resweepAll(reason)),
  async userExists(userId) {
    const rows = await getDb().select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    return rows.length > 0;
  },
  setPersonKey: setUserSecret,
  clearPersonKey: clearUserSecret,
};

export function registerServicesAdminRoutes(
  router: Router,
  requireAdmin: RequestHandler,
  deps: ServicesRouteDeps = defaultServicesRouteDeps,
): void {
  const actor = (req: Request) => (req as AuthenticatedRequest).userId;
  const param = (req: Request, name: string): string => {
    const v = req.params[name];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };
  const findService = (req: Request, res: Response): ServiceDefinition | null => {
    const def = deps.services().find((s) => s.name === param(req, "service")) ?? null;
    if (!def) res.status(404).json({ error: "No such service" });
    return def;
  };
  const readValue = (req: Request): string | null => {
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_KEY_LENGTH ? trimmed : null;
  };
  const badValue = (res: Response) =>
    res.status(400).json({ error: `value must be a non-empty string of at most ${MAX_KEY_LENGTH} characters` });
  const failed = (res: Response, err: unknown, what: string) => {
    systemLogger.error(`Admin services: failed to ${what}`, err, { operation: "admin_services_failed", what });
    res.status(500).json({ error: `Failed to ${what}` });
  };
  /** Changes wait for the one-time import, so it can't undo or overwrite them. */
  const isReady = async (res: Response): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      deps.ready().then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), READY_WAIT_MS))),
    ]);
    clearTimeout(timer);
    if (!ready) res.status(503).json({ error: "Services are still starting; try again in a moment" });
    return ready;
  };
  const log = (operation: string, ctx: Record<string, unknown>) =>
    systemLogger.info(`Admin services: ${operation.replace(/^admin_service_/, "").replace(/_/g, " ")}`, {
      operation,
      ...ctx,
    });

  router.get("/admin/services", requireAdmin, async (_req, res) => {
    try {
      const store = deps.keyStore;
      res.json({
        keyStore: { kind: store.kind, writable: store.writable },
        services: await listServices(deps.services(), deps),
      });
    } catch (err) {
      failed(res, err, "list services");
    }
  });

  router.get("/admin/services/:service", requireAdmin, async (req, res) => {
    try {
      const def = findService(req, res);
      if (!def) return;
      const store = deps.keyStore;
      res.json({
        keyStore: { kind: store.kind, writable: store.writable },
        service: await serviceDetail(def, deps),
      });
    } catch (err) {
      failed(res, err, "load the service");
    }
  });

  router.put("/admin/services/:service/keys/:name", requireAdmin, async (req, res) => {
    try {
      if (!(await isReady(res))) return;
      const def = findService(req, res);
      if (!def) return;
      const name = param(req, "name");
      if (!Object.hasOwn(def.secrets ?? {}, name)) return res.status(404).json({ error: "No such key" });
      if (!deps.keyStore.writable) {
        return res.status(409).json({ error: `Keys are read from ${deps.keyStore.kind} and can't be changed here` });
      }
      const value = readValue(req);
      if (value === null) return badValue(res);
      await deps.keyStore.set(def.name, name, value, actor(req));
      log("admin_service_key_set", { service: def.name, name, actorId: actor(req) });
      res.json({ ok: true });
    } catch (err) {
      failed(res, err, "save the key");
    }
  });

  router.delete("/admin/services/:service/keys/:name", requireAdmin, async (req, res) => {
    try {
      if (!(await isReady(res))) return;
      const def = findService(req, res);
      if (!def) return;
      const name = param(req, "name");
      if (!Object.hasOwn(def.secrets ?? {}, name)) return res.status(404).json({ error: "No such key" });
      if (!deps.keyStore.writable) {
        return res.status(409).json({ error: `Keys are read from ${deps.keyStore.kind} and can't be changed here` });
      }
      const removed = await deps.keyStore.remove(def.name, name);
      log("admin_service_key_removed", { service: def.name, name, removed, actorId: actor(req) });
      res.json({ ok: true, removed });
    } catch (err) {
      failed(res, err, "remove the key");
    }
  });

  router.put("/admin/services/:service/settings/:name", requireAdmin, async (req, res) => {
    try {
      if (!(await isReady(res))) return;
      const def = findService(req, res);
      if (!def) return;
      const name = param(req, "name");
      const spec = Object.hasOwn(def.settings ?? {}, name) ? def.settings![name] : undefined;
      if (!spec) return res.status(404).json({ error: "No such setting" });
      const value = (req.body as { value?: unknown } | undefined)?.value;
      if (typeof value !== "string") return res.status(400).json({ error: "value must be a string" });
      if (value === "") {
        await deps.clearSetting(def.name, name);
      } else if (spec.options.some((o) => o.value === value)) {
        await deps.setSetting(def.name, name, value, actor(req));
      } else {
        return res.status(400).json({ error: `value must be one of: ${spec.options.map((o) => o.value).join(", ")}` });
      }
      log("admin_service_setting_set", { service: def.name, name, value, actorId: actor(req) });
      res.json({ ok: true });
    } catch (err) {
      failed(res, err, "save the setting");
    }
  });

  router.put("/admin/services/:service/machines/:machineId", requireAdmin, async (req, res) => {
    try {
      if (!(await isReady(res))) return;
      const def = findService(req, res);
      if (!def) return;
      const machineId = param(req, "machineId");
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
      if (!(await deps.listAgentMachines()).some((m) => m.machineId === machineId)) {
        return res.status(404).json({ error: "No such machine" });
      }
      const changed = await deps.setEnabled(def.name, machineId, enabled, actor(req));
      if (changed) deps.resweep(`agent service ${def.name} switched ${enabled ? "on" : "off"}`);
      log("admin_service_machine_switched", { service: def.name, machineId, enabled, changed, actorId: actor(req) });
      res.json({ ok: true, changed });
    } catch (err) {
      failed(res, err, "switch the machine");
    }
  });

  const personKey = async (req: Request, res: Response) => {
    const def = findService(req, res);
    if (!def) return null;
    const name = param(req, "name");
    if (!Object.hasOwn(def.userSecrets ?? {}, name)) {
      res.status(404).json({ error: "No such per-person key" });
      return null;
    }
    if (!(await deps.userExists(param(req, "userId")))) {
      res.status(404).json({ error: "User not found" });
      return null;
    }
    return { def, name, userId: param(req, "userId") };
  };

  router.put("/admin/services/:service/people/:userId/keys/:name", requireAdmin, async (req, res) => {
    try {
      if (!(await isReady(res))) return;
      const target = await personKey(req, res);
      if (!target) return;
      const value = readValue(req);
      if (value === null) return badValue(res);
      await deps.setPersonKey(target.userId, target.def.name, target.name, value, actor(req));
      log("admin_service_person_key_set", { service: target.def.name, name: target.name, userId: target.userId, actorId: actor(req) });
      res.json({ ok: true });
    } catch (err) {
      failed(res, err, "save the person's key");
    }
  });

  router.delete("/admin/services/:service/people/:userId/keys/:name", requireAdmin, async (req, res) => {
    try {
      if (!(await isReady(res))) return;
      const target = await personKey(req, res);
      if (!target) return;
      const removed = await deps.clearPersonKey(target.userId, target.def.name, target.name);
      log("admin_service_person_key_removed", { service: target.def.name, name: target.name, userId: target.userId, removed, actorId: actor(req) });
      res.json({ ok: true, removed });
    } catch (err) {
      failed(res, err, "remove the person's key");
    }
  });
}
