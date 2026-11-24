// Ask hosts one at a time until one answers — for fleet-wide questions where
// every host gives the same answer (e.g. relay-room placement, which lives on
// the one chat server). Resolves null when none answers or the caller has
// stopped caring.
export async function askFirstAnsweringHost<T>(
  hostIds: readonly number[],
  ask: (hostId: number) => Promise<T>,
  isCancelled: () => boolean = () => false,
): Promise<T | null> {
  for (const hostId of hostIds) {
    if (isCancelled()) return null;
    try {
      return await ask(hostId);
    } catch {
      // Try the next host.
    }
  }
  return null;
}
