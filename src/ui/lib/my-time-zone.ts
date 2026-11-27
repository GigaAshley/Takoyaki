/**
 * my-time-zone — the signed-in person's own time zone, as the app knows it.
 *
 * The saved zone follows the browser the person uses the app from: while the
 * app is open (on start, on coming back to the front, and every few minutes)
 * this browser compares its zone with the saved one and reports it only when
 * they differ. The server ignores the report while the zone is pinned or when
 * the browser is in plain UTC; this side skips those cases too, so nothing is
 * sent when there's nothing to change.
 *
 * "Your time zone" everywhere in the app (the scheduling forms included) is
 * myTimeZone(): the saved zone, or this browser's when nothing is saved yet.
 * The wall-clock helpers below read and write times in a given zone, so a
 * typed "Friday 9:00" means 9:00 in that zone whatever the computer's clock.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  getMyTimeZone,
  reportBrowserTimeZone,
  type MyTimeZone,
} from "@/api/user-time-zone-api";
import { systemLogger } from "@/lib/frontend-logger";

/** How often an open app re-checks the browser's zone. */
export const FOLLOW_INTERVAL_MS = 5 * 60 * 1000;

/** This browser's IANA zone, or null when it won't say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** True for plain UTC under any of its names (UTC, Etc/UTC, GMT, Zulu, …). */
export function isPlainUtc(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone === "UTC";
  } catch {
    return false;
  }
}

/** Every zone this browser knows, for the pin picker. */
export function knownTimeZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    );
    if (list && list.length > 0) return list.includes("UTC") ? list : [...list, "UTC"];
  } catch {
    // fall through
  }
  const own = browserTimeZone();
  return own ? [own, "UTC"] : ["UTC"];
}

// ─── The saved zone ──────────────────────────────────────────────────────────

type State = MyTimeZone & { loaded: boolean };

let state: State = { timeZone: null, pinned: false, loaded: false };
const listeners = new Set<() => void>();

function setState(next: MyTimeZone): void {
  if (state.loaded && state.timeZone === next.timeZone && state.pinned === next.pinned) return;
  state = { ...next, loaded: true };
  for (const l of listeners) l();
}

/** Callers that change the zone (the Preferences pin) hand the answer back. */
export function setMyTimeZone(next: MyTimeZone): void {
  setState(next);
}

export function getMyTimeZoneState(): State {
  return state;
}

/** The person's time zone: the saved one, else this browser's (UTC when the
 *  browser won't say). Never a guess. */
export function myTimeZone(): string {
  return state.timeZone ?? browserTimeZone() ?? "UTC";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The saved zone and whether it's pinned, re-rendering when they change. */
export function useMyTimeZoneState(): State {
  return useSyncExternalStore(subscribe, getMyTimeZoneState, getMyTimeZoneState);
}

/** myTimeZone(), re-rendering when it changes. */
export function useMyTimeZone(): string {
  useMyTimeZoneState();
  return myTimeZone();
}

/** Test hook: forget what's known. */
export function __resetMyTimeZoneForTests(next?: Partial<State>): void {
  state = { timeZone: null, pinned: false, loaded: false, ...next };
  inFlight = null;
  followingUserId = null;
  for (const l of listeners) l();
}

// ─── Following the browser ───────────────────────────────────────────────────

let inFlight: Promise<void> | null = null;

/**
 * Compare this browser's zone with the saved one and report it when they
 * differ (loading the saved zone first if it isn't known yet). Never throws;
 * concurrent calls share one check.
 */
export function followBrowserTimeZone(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      if (!state.loaded) setState(await getMyTimeZone());
      const own = browserTimeZone();
      if (!own || state.pinned || isPlainUtc(own) || own === state.timeZone) return;
      const before = state.timeZone;
      setState(await reportBrowserTimeZone(own));
      systemLogger.info("Time zone follows this browser", {
        operation: "time_zone_followed_browser",
        from: before,
        to: state.timeZone,
        browserTimeZone: own,
      });
    } catch (err) {
      systemLogger.warn("Couldn't check the time zone against this browser", {
        operation: "time_zone_follow_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let followingUserId: string | null = null;

/** Mounted once for the signed-in person: checks on start, whenever the app
 *  comes back to the front, and every few minutes while it's open. A
 *  different person signing in starts from nothing known. */
export function useFollowBrowserTimeZone(userId: string | null): void {
  useEffect(() => {
    if (!userId) return;
    if (followingUserId !== null && followingUserId !== userId) {
      state = { timeZone: null, pinned: false, loaded: false };
      for (const l of listeners) l();
    }
    followingUserId = userId;
    void followBrowserTimeZone();
    const onVisible = () => {
      if (document.visibilityState === "visible") void followBrowserTimeZone();
    };
    const onFocus = () => void followBrowserTimeZone();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void followBrowserTimeZone(), FOLLOW_INTERVAL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [userId]);
}

// ─── Wall clock in a zone ────────────────────────────────────────────────────

export type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The wall clock in `zone` at instant `ms`. */
export function wallClockAt(ms: number, zone: string): WallClock & { second: number } {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(zone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Minutes east of UTC in `zone` at instant `ms`. */
export function zoneOffsetMinutes(ms: number, zone: string): number {
  const w = wallClockAt(ms, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The instant a wall-clock time in `zone` names. A time skipped by a
 *  spring-forward lands just after the jump; a repeated one at its first
 *  occurrence. */
export function wallClockToInstant(w: WallClock, zone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const DAY = 86400000;
  const before = zoneOffsetMinutes(guess - DAY, zone);
  const offsets = new Set([before, zoneOffsetMinutes(guess, zone), zoneOffsetMinutes(guess + DAY, zone)]);
  let best: number | null = null;
  for (const off of offsets) {
    const t = guess - off * 60000;
    if (zoneOffsetMinutes(t, zone) === off && (best === null || t < best)) best = t;
  }
  // No offset fits: the time was skipped. Read it with the offset in force
  // before the jump, which lands after it.
  return best ?? guess - before * 60000;
}

/** "YYYY-MM-DDTHH:MM" → its parts, or null. */
export function parseLocalInput(value: string): WallClock | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] };
}
