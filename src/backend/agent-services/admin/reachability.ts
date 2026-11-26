/**
 * agent-services/admin/reachability.ts — which host rows the services scan
 * currently can't reach, for the Services view. The scan (boot.ts) plugs in
 * its source; until it runs, every host reads as reachable.
 */

let source: ((hostId: string) => number | null) | null = null;

export function setReachabilitySource(fn: (hostId: string) => number | null): void {
  source = fn;
}

/** When the scan stopped reaching this host row (ms), or null. */
export function unreachableSince(hostId: string): number | null {
  return source?.(hostId) ?? null;
}
