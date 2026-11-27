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
 *   POST   /users/admin/service-machines/:machineId/revoke         cut the machine off
 *   POST   /users/admin/service-machines/:machineId/issue          give it a new credential
 *
 * Write-only: no response ever carries a key value, to admins either. A
 * machine switch re-sweeps hosts, so the service's skill and helper arrive
 * on (or leave) the machine within a minute. The service list also carries
 * each machine's credential state (machine-credentials/); a revoke or a new
 * credential reaches the machine at once.
 */

import type { Request, RequestHandler, Response, Router } from "express";
import { eq } from "drizzle-orm";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { getDb } from "../../database/db/index.js";
import { users } from "../../database/db/schema.js";
import { systemLogger } from "../../utils/logger.js";
import { requireRecentAuth } from "../../utils/recent-auth.js";
import type { ServiceDefinition } from "../engine/types.js";
import { AGENT_SERVICES } from "../registry.js";
import {
  issueNewMachineCredential,
  listMachineCredentialStatus,
  revokeMachineCredential,
} from "../machine-credentials/store.js";
import { deliverCredentialsNow } from "../machine-credentials/delivery.js";
import { listAgentMachines } from "./machines.js";
import {
  clearUserSecret,
  listServiceUserSecretStatus,
  setUserSecret,
} from "../user-secrets/store.js";
import { getSubstrateOrchestrator } from "../../distributor/substrate-orchestrator-singleton.js";
import { getKeyStore, KeyStoreRefusedError } from "./key-store.js";
import { ParameterStoreUnreachableError } from "./parameter-store.js";
import { clearSetting, effectiveSettings, setSetting, storedSettings } from "./settings-store.js";
import { enabledMachines, setEnabled } from "./grants.js";
import { serviceHealth, usageSummary } from "./usage.js";
import {
  listServices,
  machineCredentials,
  serviceDetail,
  type AgentMachine,
  type OverviewDeps,
} from "./overview.js";

/** Longest key accepted. Generous for tokens; stops accidental pastes of whole files. */
export const MAX_KEY_LENGTH = 8192;

export interface ServicesRouteDeps extends OverviewDeps {
  services(): readonly ServiceDefinition[];
  setSetting(service: string, name: string, value: string, by: string): Promise<void>;
  clearSetting(service: string, name: string): Promise<void>;
  setEnabled(service: string, machineId: string, enabled: boolean, by: string): Promise<boolean>;
  /** Push or withdraw skills after a switch changed. */
  resweep(reason: string): void;
  userExists(userId: string): Promise<boolean>;
  setPersonKey(userId: string, service: string, name: string, value: string, by: string): Promise<void>;
  clearPersonKey(userId: string, service: string, name: string): Promise<boolean>;
  revokeMachine(machineId: string, by: string): Promise<void>;
  issueMachine(machineId: string): Promise<void>;
  /** Write credential changes to the machines now. */
  deliverCredentials(): Promise<void>;
}

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
  listMachineCredentialStatus,
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
  revokeMachine: (machineId, by) => revokeMachineCredential(machineId, by),
  issueMachine: (machineId) => issueNewMachineCredential(machineId),
  deliverCredentials: deliverCredentialsNow,
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
  /**
   * A key change the store couldn't make: AWS refused it (a setup mistake
   * the admin fixes) or couldn't be reached. The message says which, and
   * what to fix; anything else is an unexpected failure.
   */
  const keyChangeFailed = (res: Response, err: unknown, what: string) => {
    if (err instanceof KeyStoreRefusedError || err instanceof ParameterStoreUnreachableError) {
      systemLogger.warn(`Admin services: couldn't ${what}`, {
        operation: "admin_services_key_store_refused",
        what,
        error: err.message,
      });
      return res
        // 424, not a 5xx: proxies that replace error pages leave it alone.
        .status(err instanceof KeyStoreRefusedError ? 424 : 503)
        .json({ error: err instanceof KeyStoreRefusedError ? err.message : `Couldn't ${what}: ${err.message}` });
    }
    return failed(res, err, what);
  };
  const log = (operation: string, ctx: Record<string, unknown>) =>
    systemLogger.info(`Admin services: ${operation.replace(/^admin_service_/, "").replace(/_/g, " ")}`, {
      operation,
      ...ctx,
    });

  router.get("/admin/services", requireAdmin, async (_req, res) => {
    try {
      const services = await listServices(deps.services(), deps);
      const machines = await machineCredentials(deps);
      // After the reads, so it reflects whether AWS just answered.
      res.json({ keyStore: deps.keyStore.info(), services, machines });
    } catch (err) {
      failed(res, err, "list services");
    }
  });

  router.get("/admin/services/:service", requireAdmin, async (req, res) => {
    try {
      const def = findService(req, res);
      if (!def) return;
      const service = await serviceDetail(def, deps);
      res.json({ keyStore: deps.keyStore.info(), service });
    } catch (err) {
      failed(res, err, "load the service");
    }
  });

  router.put("/admin/services/:service/keys/:name", requireAdmin, async (req, res) => {
    try {
      const def = findService(req, res);
      if (!def) return;
      const name = param(req, "name");
      if (!Object.hasOwn(def.secrets ?? {}, name)) return res.status(404).json({ error: "No such key" });
      const value = readValue(req);
      if (value === null) return badValue(res);
      await deps.keyStore.set(def.name, name, value, actor(req));
      log("admin_service_key_set", { service: def.name, name, actorId: actor(req) });
      res.json({ ok: true });
    } catch (err) {
      keyChangeFailed(res, err, "save the key");
    }
  });

  router.delete("/admin/services/:service/keys/:name", requireAdmin, async (req, res) => {
    try {
      const def = findService(req, res);
      if (!def) return;
      const name = param(req, "name");
      if (!Object.hasOwn(def.secrets ?? {}, name)) return res.status(404).json({ error: "No such key" });
      const removed = await deps.keyStore.remove(def.name, name);
      log("admin_service_key_removed", { service: def.name, name, removed, actorId: actor(req) });
      res.json({ ok: true, removed });
    } catch (err) {
      keyChangeFailed(res, err, "remove the key");
    }
  });

  router.put("/admin/services/:service/settings/:name", requireAdmin, async (req, res) => {
    try {
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
      const target = await personKey(req, res);
      if (!target) return;
      const removed = await deps.clearPersonKey(target.userId, target.def.name, target.name);
      log("admin_service_person_key_removed", { service: target.def.name, name: target.name, userId: target.userId, removed, actorId: actor(req) });
      res.json({ ok: true, removed });
    } catch (err) {
      failed(res, err, "remove the person's key");
    }
  });

  const machineExists = async (machineId: string) =>
    (await deps.listAgentMachines()).some((m) => m.machineId === machineId);
  // Best-effort and bounded: the next pass retries a machine it can't reach.
  const deliverSoon = () =>
    Promise.race([deps.deliverCredentials(), new Promise((r) => setTimeout(r, 5_000))]).catch(() => undefined);

  router.post("/admin/service-machines/:machineId/revoke", requireAdmin, async (req, res) => {
    try {
      const machineId = param(req, "machineId");
      if (!(await machineExists(machineId))) return res.status(404).json({ error: "No such machine" });
      await deps.revokeMachine(machineId, actor(req));
      log("admin_service_machine_revoked", { machineId, actorId: actor(req) });
      await deliverSoon();
      res.json({ ok: true });
    } catch (err) {
      failed(res, err, "revoke the machine's credential");
    }
  });

  // A new credential put onto a machine: confirm it's you (AGENTS.md § Security).
  router.post("/admin/service-machines/:machineId/issue", requireAdmin, requireRecentAuth, async (req, res) => {
    try {
      const machineId = param(req, "machineId");
      if (!(await machineExists(machineId))) return res.status(404).json({ error: "No such machine" });
      await deps.issueMachine(machineId);
      log("admin_service_machine_issued", { machineId, actorId: actor(req) });
      await deliverSoon();
      res.json({ ok: true });
    } catch (err) {
      failed(res, err, "issue the machine a new credential");
    }
  });
}
