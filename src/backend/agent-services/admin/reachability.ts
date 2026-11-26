/**
 * agent-services/admin/reachability.ts — which host rows the services scan
 * currently can't reach, for the Services view. The scan (boot.ts) plugs in
 * its source; until it runs, no host row counts as scanned.
 */

export interface HostReach {
  /** The scan visits this host row (it has SSH and a usable credential). */
  scanned: boolean;
  /** When the scan stopped reaching it (ms), or null while it's reachable. */
  since: number | null;
}

let source: ((hostId: string) => HostReach) | null = null;

export function setReachabilitySource(fn: (hostId: string) => HostReach): void {
  source = fn;
}

export function hostReach(hostId: string): HostReach {
  return source?.(hostId) ?? { scanned: false, since: null };
}
