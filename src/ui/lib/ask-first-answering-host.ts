// Ask hosts one at a time until one answers — for fleet-wide questions where
// every host gives the same answer (e.g. relay-room placement, which lives on
// the one chat server). Resolves null when none answers, when a failure would
// be the same on every host (`givesUp`), or when the caller has stopped
// caring. Put hosts known to be up first.
export async function askFirstAnsweringHost<T>(
  hostIds: readonly number[],
  ask: (hostId: number) => Promise<T>,
  isCancelled: () => boolean = () => false,
  givesUp: (err: unknown) => boolean = () => false,
): Promise<T | null> {
  for (const hostId of hostIds) {
    if (isCancelled()) return null;
    try {
      return await ask(hostId);
    } catch (err) {
      if (givesUp(err)) return null;
      // Otherwise try the next host.
    }
  }
  return null;
}
