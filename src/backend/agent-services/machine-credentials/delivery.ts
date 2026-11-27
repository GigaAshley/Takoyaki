/**
 * agent-services/machine-credentials/delivery.ts — keeps every machine
 * holding its current service credential.
 *
 * Every DELIVERY_INTERVAL_MS, for each host row set to run agents: work out
 * the credential its machine should hold (store.ts issues and replaces them)
 * and write it to `~/fleet/host/service-credential`, readable only by that
 * login, when it differs from what this process last wrote there. A revoked
 * machine's file is left alone, so its calls are told an admin revoked it.
 * A tick is database reads only unless something changed; the first tick
 * after start writes each host once (unchanged files are left alone on the
 * host). A machine that can't be
 * written to is tried again with back-off, a few machines at a time, so it
 * never holds up the rest. The credential travels on the command's input,
 * never its command line. Credentials of machines that no longer run agents
 * are dropped (store.ts keeps revoked ones).
 *
 * `fleet-service` reads the file and sends it with every request
 * (http/routes.ts). Nothing else reads it, and no route returns it.
 */

import { systemLogger } from "../../utils/logger.js";
import type { CurrentCredential } from "./store.js";

/** Relative to the login's home. */
export const CREDENTIAL_REL_PATH = "fleet/host/service-credential";
export const DELIVERY_INTERVAL_MS = 30_000;

const OK_MARK = "__SERVICE_CREDENTIAL_OK__";

export interface DeliveryHost {
  id: string;
  name: string;
  machineId?: string;
  _connDetails: Record<string, unknown>;
}

/** Runs one shell command on a host with `stdin` as its input; stdout, or null when it couldn't run. */
export type HostExec = (host: DeliveryHost, command: string, stdin: Buffer) => Promise<string | null>;

export interface DeliveryDeps {
  listHosts(): Promise<DeliveryHost[]>;
  /** Every machine set to run agents, from the hosts table (not the SSH list, which skips rows it can't decrypt). */
  listMachineIds(): Promise<string[]>;
  currentCredential(machineId: string): Promise<CurrentCredential>;
  forgetOtherMachines(machineIds: readonly string[]): Promise<number>;
  isLocalHost(host: DeliveryHost): boolean;
  /** Write the file on the machine the backend runs on. */
  writeLocal(token: string): Promise<void>;
  exec: HostExec;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(h: ReturnType<typeof setInterval>): void;
  now?: () => number;
  intervalMs?: number;
}

export interface CredentialDelivery {
  start(): void;
  stop(): void;
  /** Run a pass now (after a revoke or a new credential), trying hosts in back-off too. Resolves when it's done. */
  deliverNow(): Promise<void>;
}

/** Writes at once, at most. */
const WRITE_CONCURRENCY = 4;
/** A host whose write failed is tried again after this, doubling up to the max. */
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Shell command writing the credential (sent on stdin, so it never appears
 * in the host's process list) to the credential file, owner-only.
 */
export function credentialWriteCommand(): string {
  return [
    `F="$HOME/${CREDENTIAL_REL_PATH}"`,
    `mkdir -p "$(dirname "$F")" || exit 1`,
    `( umask 077; cat > "$F.new" ) || exit 1`,
    `if [ -f "$F" ] && cmp -s "$F" "$F.new"; then rm -f "$F.new"; chmod 600 "$F"; else mv -f "$F.new" "$F" || exit 1; fi`,
    `echo "${OK_MARK}"`,
  ].join("\n");
}

export function createCredentialDelivery(deps: DeliveryDeps): CredentialDelivery {
  const intervalMs = deps.intervalMs ?? DELIVERY_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  /** host row id → token last written there. */
  const lastWritten = new Map<string, string>();
  /** Hosts whose last write failed: when to try next, and the current wait. */
  const backoff = new Map<string, { nextAt: number; delayMs: number }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  /** Null on success, else why it failed. */
  async function writeTo(host: DeliveryHost, token: string): Promise<string | null> {
    try {
      if (deps.isLocalHost(host)) {
        await deps.writeLocal(token);
        return null;
      }
      const out = await deps.exec(host, credentialWriteCommand(), Buffer.from(`${token}\n`, "utf8"));
      if (out === null) return "couldn't run the write over SSH";
      return out.trimEnd().endsWith(OK_MARK) ? null : out.trimEnd().slice(0, 300) || "write failed";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function deliverTo(host: DeliveryHost, machineId: string, token: string): Promise<void> {
    const problem = await writeTo(host, token);
    if (problem === null) {
      lastWritten.set(host.id, token);
      if (backoff.delete(host.id)) {
        systemLogger.info("service credentials: delivered again", {
          operation: "agent_services_credential_delivery_recovered",
          fleetHostId: host.id,
          hostName: host.name,
          machineId,
        });
      }
      systemLogger.info("service credentials: delivered", {
        operation: "agent_services_credential_delivered",
        fleetHostId: host.id,
        hostName: host.name,
        machineId,
      });
      return;
    }
    const prev = backoff.get(host.id);
    const delayMs = prev ? Math.min(prev.delayMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
    backoff.set(host.id, { nextAt: now() + delayMs, delayMs });
    if (!prev) {
      systemLogger.warn("service credentials: couldn't write to a machine; retrying with back-off", {
        operation: "agent_services_credential_delivery_failed",
        fleetHostId: host.id,
        hostName: host.name,
        machineId,
        error: problem,
      });
    }
  }

  async function pass(ignoreBackoff: boolean): Promise<void> {
    let hosts: DeliveryHost[];
    try {
      hosts = await deps.listHosts();
    } catch (err) {
      systemLogger.warn("service credentials: host list failed; skipping this pass", {
        operation: "agent_services_credential_hosts_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    try {
      await deps.forgetOtherMachines(await deps.listMachineIds());
    } catch (err) {
      systemLogger.warn("service credentials: couldn't drop old machines' credentials", {
        operation: "agent_services_credential_forget_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const machineOf = (h: DeliveryHost) => h.machineId ?? h.id;
    const byMachine = new Map<string, CurrentCredential | null>();
    const writes: Array<() => Promise<void>> = [];
    for (const host of hosts) {
      const machineId = machineOf(host);
      if (!byMachine.has(machineId)) {
        try {
          byMachine.set(machineId, await deps.currentCredential(machineId));
        } catch (err) {
          byMachine.set(machineId, null);
          systemLogger.error("service credentials: couldn't read or issue a machine's credential", {
            operation: "agent_services_credential_issue_failed",
            machineId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const cred = byMachine.get(machineId);
      if (!cred) continue;
      // Revoked: leave the old (now refused) credential in place, so the
      // machine's calls get the clear "revoked" answer.
      if (cred.kind === "revoked") continue;
      if (lastWritten.get(host.id) === cred.token) continue;
      const wait = backoff.get(host.id);
      if (wait && !ignoreBackoff && now() < wait.nextAt) continue;
      writes.push(() => deliverTo(host, machineId, cred.token));
    }

    // A few at a time, so one unreachable machine never holds up the rest.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(WRITE_CONCURRENCY, writes.length) }, async () => {
        while (next < writes.length) await writes[next++]();
      }),
    );
  }

  function run(ignoreBackoff: boolean): Promise<void> {
    if (running) {
      // A pass is under way and may have read the old state: an explicit
      // request runs once more after it. The timer just skips its turn.
      if (ignoreBackoff) again = true;
      return running;
    }
    running = (async () => {
      try {
        let force = ignoreBackoff;
        do {
          again = false;
          await pass(force);
          force = true;
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const deliverNow = () => run(true);

  return {
    start() {
      if (timer) return;
      void run(false);
      timer = deps.setInterval(() => void run(false), intervalMs);
    },
    stop() {
      if (timer) deps.clearInterval(timer);
      timer = null;
    },
    deliverNow,
  };
}

let active: CredentialDelivery | null = null;

/** The running delivery (boot.ts), so admin changes can push at once. */
export function setActiveDelivery(d: CredentialDelivery | null): void {
  active = d;
}

/** Push credential changes (a revoke, a new one) to the machines now. */
export async function deliverCredentialsNow(): Promise<void> {
  await active?.deliverNow();
}
