/**
 * breaker-skip-log.ts — one log line when a background scanner starts
 * skipping a host because its connect breaker is open, and one when it gets
 * through again.
 *
 * Scanners tick every few seconds per host. While a host is down the breaker
 * refuses every tick, and the breaker itself already logs the host going
 * down and coming back (host-circuit-breaker.ts). Logging each refused tick
 * as well buried the log under one host that was simply switched off, so
 * each scanner records the change instead.
 *
 * Breaker refusals count as skipping. A scanner may route real connect
 * failures (timeouts, auth errors) through refused() too, as the agent
 * services scan does, so a machine that is simply off logs once.
 */

import type { Logger } from "../utils/logger.js";

export type SkipLogHost = { id: string; name: string };

export type BreakerSkipLog = {
  /** The breaker refused this tick's connect. Logs on the first refusal only. */
  refused(host: SkipLogHost, error: string): void;
  /** A channel was acquired. Logs only if the host was being skipped. */
  acquired(host: SkipLogHost): void;
  /** When the host started being skipped (ms), or null while it's reachable. */
  skippingSince(hostId: string): number | null;
};

export function createBreakerSkipLog(opts: {
  /** Operation prefix, e.g. "spawn_scan" → spawn_scan_host_skipping / _resumed. */
  subsystem: string;
  /** Human prefix for the message, e.g. "Spawn-scan". */
  label: string;
  logger: Pick<Logger, "info">;
  now?: () => number;
}): BreakerSkipLog {
  const now = opts.now ?? Date.now;
  const skippingSince = new Map<string, number>();
  return {
    refused(host, error) {
      if (skippingSince.has(host.id)) return;
      skippingSince.set(host.id, now());
      opts.logger.info(
        `${opts.label}: host unreachable, skipping it until it's back`,
        {
          operation: `${opts.subsystem}_host_skipping`,
          fleetHostId: host.id,
          hostName: host.name,
          error,
        },
      );
    },
    skippingSince(hostId) {
      return skippingSince.get(hostId) ?? null;
    },
    acquired(host) {
      const since = skippingSince.get(host.id);
      if (since === undefined) return;
      skippingSince.delete(host.id);
      opts.logger.info(`${opts.label}: host reachable again, resumed`, {
        operation: `${opts.subsystem}_host_resumed`,
        fleetHostId: host.id,
        hostName: host.name,
        skippedForSec: Math.round((now() - since) / 1000),
      });
    },
  };
}
