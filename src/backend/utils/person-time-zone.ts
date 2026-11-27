/**
 * person-time-zone — each person's own time zone, and the backend lookup for
 * it.
 *
 * A person's zone follows the browser they use the app from: whenever a
 * browser reports a zone that differs from the saved one, the saved one
 * becomes the browser's (applyBrowserTimeZone). Two things never change it
 * that way — a pinned zone (the person picked one in Preferences), and a
 * browser in plain UTC, which almost always means a server, cloud machine or
 * remote desktop rather than where the person is. A person can still pin UTC.
 *
 * getPersonTimeZone is the lookup for the rest of the backend (agent services
 * and anything else acting for a person): a zone name, or "not set" when the
 * app has never learned one. It never guesses — no falling back to the
 * server's or a machine's clock.
 *
 * Zones are stored exactly as the browser or the person gave them (only
 * checked to be a zone this server knows), so a browser comparing its own
 * zone with the saved one sees an exact match and has nothing to send.
 */

import { eq } from "drizzle-orm";
import { db } from "../database/db/index.js";
import { users } from "../database/db/schema.js";

const MAX_ZONE_LENGTH = 64;
const ZONE_CHARS = /^[A-Za-z0-9_+\-/]+$/;

/** True when `name` is an IANA time zone this server can use. */
export function isValidTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_ZONE_LENGTH) return false;
  if (!ZONE_CHARS.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * True for plain UTC under any of its names (UTC, Etc/UTC, GMT, Zulu, …) —
 * the zones a browser reports when its computer has no real location.
 * Fixed offsets like Etc/GMT+5 are not plain UTC.
 */
export function isPlainUtc(name: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone === "UTC";
  } catch {
    return false;
  }
}

export type PersonTimeZone =
  | { status: "set"; timeZone: string; pinned: boolean }
  | { status: "not_set" }
  | { status: "no_such_person" };

/** What a stored row says, shaped for the lookup. */
function fromRow(row: { timeZone: string | null; timeZonePinned: boolean }): PersonTimeZone {
  return row.timeZone
    ? { status: "set", timeZone: row.timeZone, pinned: row.timeZonePinned }
    : { status: "not_set" };
}

async function readRow(
  userId: string,
): Promise<{ timeZone: string | null; timeZonePinned: boolean } | null> {
  const rows = await db
    .select({ timeZone: users.timeZone, timeZonePinned: users.timeZonePinned })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A person's time zone by their user id: `set` with the IANA name (and
 * whether they pinned it), `not_set` when the app has never learned one, or
 * `no_such_person`.
 */
export async function getPersonTimeZone(userId: string): Promise<PersonTimeZone> {
  const row = await readRow(userId);
  return row ? fromRow(row) : { status: "no_such_person" };
}

export type TimeZoneChange = { result: PersonTimeZone; changed: boolean };

/**
 * A browser the person is using reports `browserZone`. The saved zone
 * becomes it unless the zone is pinned, the browser is in plain UTC, or it
 * already matches. Callers validate `browserZone` first.
 */
export async function applyBrowserTimeZone(
  userId: string,
  browserZone: string,
): Promise<TimeZoneChange> {
  const row = await readRow(userId);
  if (!row) return { result: { status: "no_such_person" }, changed: false };
  if (row.timeZonePinned || isPlainUtc(browserZone) || row.timeZone === browserZone) {
    return { result: fromRow(row), changed: false };
  }
  await db.update(users).set({ timeZone: browserZone }).where(eq(users.id, userId));
  return { result: { status: "set", timeZone: browserZone, pinned: false }, changed: true };
}

/** The person pins `zone` (validated by the caller); browsers stop changing it. */
export async function pinTimeZone(userId: string, zone: string): Promise<TimeZoneChange> {
  const row = await readRow(userId);
  if (!row) return { result: { status: "no_such_person" }, changed: false };
  const changed = row.timeZone !== zone || !row.timeZonePinned;
  if (changed) {
    await db.update(users).set({ timeZone: zone, timeZonePinned: true }).where(eq(users.id, userId));
  }
  return { result: { status: "set", timeZone: zone, pinned: true }, changed };
}

/**
 * The person goes back to following their browser. The browser they're
 * unpinning from takes over at once (unless it's plain UTC or not given, in
 * which case the pinned zone stays saved until a browser reports another).
 */
export async function unpinTimeZone(
  userId: string,
  browserZone: string | null,
): Promise<TimeZoneChange> {
  const row = await readRow(userId);
  if (!row) return { result: { status: "no_such_person" }, changed: false };
  const takeOver = browserZone !== null && !isPlainUtc(browserZone);
  const nextZone = takeOver ? browserZone : row.timeZone;
  const changed = row.timeZonePinned || nextZone !== row.timeZone;
  if (changed) {
    await db
      .update(users)
      .set({ timeZone: nextZone, timeZonePinned: false })
      .where(eq(users.id, userId));
  }
  return { result: fromRow({ timeZone: nextZone, timeZonePinned: false }), changed };
}
