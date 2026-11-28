/**
 * agent-services/boot.ts — start the engine, the job store and credential
 * delivery. Called once from starter.ts.
 *
 * Machines send requests straight to the backend (http/routes.ts, mounted
 * by database.ts); this hands that router the running engine and job store.
 * The key store is the one the instance chose in its server settings
 * (admin/choose-store.ts), picked on first use. The engine reads keys,
 * settings and machine switches from the stores in admin/, and records each
 * answer there. Identity reactivate, and new agents and roles
 * (spawn-requests/direct-route.ts), are the app's own machinery riding the
 * same requests: core handlers, answered for every machine.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { systemLogger } from "../utils/logger.js";
import { listSubstrateHosts } from "../distributor/list-substrate-hosts.js";
import { getDb } from "../database/db/index.js";
import { connectOneShot } from "../ssh/ssh-one-shot.js";
import { createSemaphoredExecChannel } from "../ssh/semaphored-exec-channel.js";
import { getHostSemaphore } from "../ssh/host-semaphore-registry.js";
import { isLocalHostId } from "../claude-session/identity-artifact-reader.js";
import { createAgentServiceEngine } from "./engine/engine.js";
import { createJobStore } from "./engine/jobs.js";
import { setServiceRuntime } from "./http/production.js";
import { AGENT_SERVICES } from "./registry.js";
import { resolveActingUser } from "./user-secrets/acting-user.js";
import { getUserSecret } from "./user-secrets/store.js";
import identityReactivate from "../matrix/identity-reactivate.js";
import { createDirectBirthServices } from "../spawn-requests/direct-route.js";
import { enqueue as enqueueBirth } from "../spawn-requests/queue.js";
import { getKeyStore } from "./admin/key-store.js";
import { effectiveSettings } from "./admin/settings-store.js";
import { isEnabled } from "./admin/grants.js";
import { recordUsage } from "./admin/usage.js";
import { warnOrphanedGrants } from "./admin/orphaned-grants.js";
import { listAgentMachines } from "./admin/machines.js";
import { currentCredential, forgetOtherMachines } from "./machine-credentials/store.js";
import {
  CREDENTIAL_REL_PATH,
  createCredentialDelivery,
  setActiveDelivery,
  type CredentialDelivery,
  type DeliveryHost,
} from "./machine-credentials/delivery.js";

const JOB_SWEEP_INTERVAL_MS = 60_000;
const DELIVERY_SSH_CONNECT_TIMEOUT_MS = 10_000;
const DELIVERY_EXEC_TIMEOUT_MS = 30_000;

let delivery: CredentialDelivery | null = null;

/** The local login's credential file, through the host-home bind mount. */
async function writeLocalCredential(token: string): Promise<void> {
  const home = process.env.HOME_HOST_DIR || os.homedir();
  const target = path.join(home, CREDENTIAL_REL_PATH);
  const current = await fs.readFile(target, "utf8").catch(() => null);
  if (current === `${token}\n`) return;
  // The container runs as root; what it creates must belong to the login that reads it.
  const owner = await fs.stat(home);
  const dir = path.dirname(target);
  const madeDir = await fs.mkdir(dir, { recursive: true });
  if (madeDir) await fs.chown(dir, owner.uid, owner.gid);
  const tmp = `${target}.new`;
  await fs.writeFile(tmp, `${token}\n`, { mode: 0o600 });
  await fs.chown(tmp, owner.uid, owner.gid);
  await fs.rename(tmp, target);
}

/** One command over a short-lived SSH connection: writes are rare (a change, or once per start). */
async function execOnHost(host: DeliveryHost, command: string, stdin: Buffer): Promise<string | null> {
  const client = await connectOneShot(
    host._connDetails as Parameters<typeof connectOneShot>[0],
    DELIVERY_SSH_CONNECT_TIMEOUT_MS,
  );
  try {
    const channel = createSemaphoredExecChannel({
      client,
      hostId: host.id,
      subsystem: "agent_services_credentials",
      defaultTimeoutMs: DELIVERY_EXEC_TIMEOUT_MS,
      semaphore: getHostSemaphore(host.id),
    });
    return await channel.exec(command, stdin);
  } finally {
    try {
      client.end();
    } catch {
      // already gone
    }
  }
}

export async function startAgentServices(): Promise<void> {
  // Choose now (if nothing has yet), so a setup mistake is logged at start.
  getKeyStore();
  await warnOrphanedGrants();

  const directRouteDeps = {
    enqueue: enqueueBirth,
    connDetailsFor: async (hostId: string) => {
      const hosts = await listSubstrateHosts({ getDb });
      return hosts.find((h) => h.id === hostId)?._connDetails ?? null;
    },
  };
  const directBirth = createDirectBirthServices(directRouteDeps);
  const coreHandlers = [identityReactivate, ...directBirth];
  const engine = createAgentServiceEngine({
    services: AGENT_SERVICES,
    coreHandlers,
    isEnabled,
    getKey: (service, name) => getKeyStore().get(service, name),
    getSettings: (def) => effectiveSettings(def.name, def.settings),
    recordUsage: (r) => recordUsage(r),
    resolveActingUser,
    loadUserSecret: getUserSecret,
  });
  const jobs = createJobStore();
  const sweepTimer = setInterval(() => jobs.sweep(), JOB_SWEEP_INTERVAL_MS);
  setServiceRuntime({ engine, jobs, services: [...AGENT_SERVICES, ...coreHandlers] });

  delivery = createCredentialDelivery({
    listHosts: () => listSubstrateHosts({ getDb }),
    listMachineIds: async () => (await listAgentMachines()).map((m) => m.machineId),
    currentCredential: (machineId) => currentCredential(machineId),
    forgetOtherMachines,
    isLocalHost: (host) => isLocalHostId(parseInt(host.id, 10)),
    writeLocal: writeLocalCredential,
    exec: execOnHost,
    setInterval,
    clearInterval,
  });
  setActiveDelivery(delivery);
  delivery.start();

  systemLogger.info("Agent services started", {
    operation: "agent_services_started",
    services: AGENT_SERVICES.map((s) => s.name),
    keyStore: getKeyStore().info().label,
  });

  process.once("SIGTERM", () => {
    delivery?.stop();
    setActiveDelivery(null);
    clearInterval(sweepTimer);
    engine.stop();
    setServiceRuntime(null);
  });
}
