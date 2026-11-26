/**
 * agent-services/boot.ts — start the engine and its scan loop. Called once
 * from starter.ts; replaces the per-service boot blocks that used to live
 * there.
 *
 * The key store is the one the instance chose in its server settings
 * (admin/choose-store.ts), picked on first use. The engine reads keys,
 * settings and machine switches from the stores in admin/, and records each
 * answer there. Identity reactivate is the app's own machinery riding the
 * same request files: a core handler, answered for every machine.
 *
 * Every agent machine is read each tick (an un-archive request can come from
 * any). A machine that can't be reached is logged once when it goes and once
 * when it's back, never per tick; admin/reachability.ts tells the Services
 * view.
 */

import type { Client as SSHClientType } from "ssh2";
import { systemLogger } from "../utils/logger.js";
import { listSubstrateHosts } from "../distributor/list-substrate-hosts.js";
import { getDb } from "../database/db/index.js";
import { hosts } from "../database/db/schema.js";
import { eq } from "drizzle-orm";
import { connectOneShot } from "../ssh/ssh-one-shot.js";
import { enableHostd } from "../ssh/hostd-channel.js";
import { createSemaphoredExecChannel } from "../ssh/semaphored-exec-channel.js";
import { getHostSemaphore } from "../ssh/host-semaphore-registry.js";
import { createBreakerSkipLog } from "../ssh/breaker-skip-log.js";
import { resolveHostById } from "../ssh/host-resolver.js";
import { SSH_CONNECT_TIMEOUT_MS } from "../database/routes/identity-birth-orchestrator.js";
import {
  isLocalHostId,
  writeBinaryFileAtomic,
  writeMarkdownFileAtomic,
} from "../claude-session/identity-artifact-reader.js";
import { createAgentServiceEngine } from "./engine/engine.js";
import {
  createResponseWriter,
  localRequestIo,
  sshRequestIo,
  AGENT_SERVICES_EXEC_TIMEOUT_MS,
  type SshChannel,
} from "./engine/host-io.js";
import {
  createScanOrchestrator,
  type ScanHostRecord,
} from "./engine/scan-orchestrator.js";
import { AGENT_SERVICES } from "./registry.js";
import { resolveActingUser } from "./user-secrets/acting-user.js";
import { getUserSecret } from "./user-secrets/store.js";
import identityReactivate from "../matrix/identity-reactivate.js";
import { getKeyStore } from "./admin/key-store.js";
import { effectiveSettings } from "./admin/settings-store.js";
import { isEnabled } from "./admin/grants.js";
import { recordUsage } from "./admin/usage.js";
import { warnOrphanedGrants } from "./admin/orphaned-grants.js";
import { setReachabilitySource } from "./admin/reachability.js";

const SCAN_INTERVAL_MS = 10_000;

async function getHostOwnerUserId(hostIdNum: number): Promise<string | null> {
  const rows = await getDb()
    .select({ userId: hosts.userId })
    .from(hosts)
    .where(eq(hosts.id, hostIdNum))
    .limit(1);
  return rows[0]?.userId ?? null;
}

// Latest system-wrapped (CSKEK) conn details per substrate host, refreshed on
// every scan tick. The response writer uses these so replies never depend on
// the host owner's per-user data key (only in memory during a live session).
const systemConnDetailsByHost = new Map<string, Record<string, unknown>>();

async function listSubstrateHostsCaching() {
  const list = await listSubstrateHosts({ getDb });
  systemConnDetailsByHost.clear();
  for (const h of list) systemConnDetailsByHost.set(h.id, h._connDetails);
  scannedHostIds = new Set(list.map((h) => h.id));
  return list;
}

/** The host rows the last scan tick visited, for the Services view. */
let scannedHostIds = new Set<string>();

async function getSystemConnDetails(
  hostIdNum: number,
): Promise<Record<string, unknown> | null> {
  const key = String(hostIdNum);
  const cached = systemConnDetailsByHost.get(key);
  if (cached) return cached;
  // Cache miss (e.g. first tick not yet complete) — fetch fresh.
  await listSubstrateHostsCaching();
  return systemConnDetailsByHost.get(key) ?? null;
}

export async function startAgentServices(): Promise<void> {
  // Choose now (if nothing has yet), so a setup mistake is logged at start.
  getKeyStore();
  await warnOrphanedGrants();

  const engine = createAgentServiceEngine({
    services: AGENT_SERVICES,
    coreHandlers: [identityReactivate],
    isEnabled,
    getKey: (service, name) => getKeyStore().get(service, name),
    getSettings: (def) => effectiveSettings(def.name, def.settings),
    recordUsage: (r) => recordUsage(r),
    resolveActingUser,
    loadUserSecret: getUserSecret,
    writeResponse: createResponseWriter({
      isLocalHostId,
      getSystemConnDetails,
      getHostOwnerUserId,
      resolveHostById,
      connect: (hostDetails) =>
        connectOneShot(
          hostDetails as Parameters<typeof connectOneShot>[0],
          SSH_CONNECT_TIMEOUT_MS,
        ),
      writeTextAtomic: writeMarkdownFileAtomic,
      writeBinaryAtomic: writeBinaryFileAtomic,
    }),
  });

  // Scan connections are reused across ticks for the life of the process.
  const scanClients = new Map<string, SSHClientType>();
  const skipLog = createBreakerSkipLog({
    subsystem: "agent_services_scan",
    label: "agent-services scan",
    logger: systemLogger,
  });
  setReachabilitySource((hostId) => ({
    scanned: scannedHostIds.has(hostId),
    since: skipLog.skippingSince(hostId),
  }));

  async function acquireChannel(
    host: ScanHostRecord,
  ): Promise<SshChannel | null> {
    try {
      let client = scanClients.get(host.id);
      if (!client) {
        client = await connectOneShot(
          host._connDetails as Parameters<typeof connectOneShot>[0],
          10_000,
        );
        scanClients.set(host.id, client);
        enableHostd(client);
        const forget = () => scanClients.delete(host.id);
        client.on("end", forget);
        client.on("close", forget);
        client.on("error", forget);
      }
      // Shared per-host semaphore: bounds exec channels across every SSH
      // producer talking to this host. The exec timeout is passed into
      // execCommand so a wedged exec frees its slot (default 30s = scan
      // timeout; attachment reads pass a longer budget).
      skipLog.acquired(host);
      return createSemaphoredExecChannel({
        client,
        hostId: host.id,
        subsystem: "agent_services_scan",
        defaultTimeoutMs: AGENT_SERVICES_EXEC_TIMEOUT_MS,
        semaphore: getHostSemaphore(host.id),
      });
    } catch (err) {
      // Breaker open or a real connect failure: either way the host can't be
      // reached. Log the change only (one line when it goes, one when it's
      // back), never every ten-second tick.
      skipLog.refused(host, err instanceof Error ? err.message : "unknown");
      return null;
    }
  }

  const orchestrator = createScanOrchestrator({
    listSubstrateHosts: listSubstrateHostsCaching,
    acquireChannel,
    isLocalHostId,
    sshIo: sshRequestIo,
    localIo: () => localRequestIo(),
    intake: engine.intake,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    scanIntervalMs: SCAN_INTERVAL_MS,
  });

  void orchestrator.start();
  systemLogger.info("Agent services started", {
    operation: "agent_services_started",
    services: AGENT_SERVICES.map((s) => s.name),
    keyStore: getKeyStore().info().label,
    scanIntervalMs: SCAN_INTERVAL_MS,
  });

  process.once("SIGTERM", () => {
    orchestrator.stop();
    engine.stop();
    for (const client of scanClients.values()) {
      try {
        client.end();
      } catch {
        // already gone
      }
    }
    scanClients.clear();
  });
}
