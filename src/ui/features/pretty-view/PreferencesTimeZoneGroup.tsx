/**
 * Preferences → account → Time zone. Shows the person's saved zone and
 * whether it follows this browser or is pinned, with Pin / Change / Unpin.
 *
 * Following the browser is the default and needs nothing from the person
 * (lib/my-time-zone.ts does it while the app is open). Pinning picks a zone
 * from a searchable list; while pinned no browser changes it. Unpinning hands
 * the zone back to this browser at once (unless it's in plain UTC).
 */

import { useEffect, useMemo, useState } from "react";
import { pinMyTimeZone, unpinMyTimeZone } from "@/api/user-time-zone-api";
import {
  browserTimeZone,
  followBrowserTimeZone,
  knownTimeZones,
  setMyTimeZone,
  useMyTimeZoneState,
} from "@/lib/my-time-zone";
import {
  KitBanner,
  KitButton,
  KitSearch,
  KitSettingsGroup,
  KitSettingsRow,
} from "@/components/kit";

/** "America/New_York" → "America/New York". */
export function timeZoneLabel(zone: string): string {
  return zone.replace(/_/g, " ");
}

function matches(zone: string, query: string): boolean {
  const words = query.toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
  const name = timeZoneLabel(zone).toLowerCase();
  return words.every((w) => name.includes(w));
}

export function PreferencesTimeZoneGroup(): JSX.Element {
  const { timeZone, pinned, loaded } = useMyTimeZoneState();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Normally already known (the app shell follows the browser from the
  // start); if not — e.g. that first load failed — check now.
  useEffect(() => {
    if (!loaded) void followBrowserTimeZone();
  }, [loaded]);

  const zones = useMemo(() => (picking ? knownTimeZones() : []), [picking]);
  const shown = useMemo(() => zones.filter((z) => matches(z, query)), [zones, query]);

  const pin = async (zone: string) => {
    setBusy(true);
    setError(null);
    try {
      setMyTimeZone(await pinMyTimeZone(zone));
      setPicking(false);
      setQuery("");
    } catch {
      setError("Couldn't pin your time zone — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const unpin = async () => {
    setBusy(true);
    setError(null);
    try {
      setMyTimeZone(await unpinMyTimeZone(browserTimeZone()));
    } catch {
      setError("Couldn't unpin your time zone — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const description = !loaded
    ? "Checking…"
    : pinned
      ? "Pinned — browsers won't change it."
      : timeZone
        ? "Follows this browser, and changes when you use the app somewhere else."
        : "Not known yet. It's learned from the browser you use the app from.";

  return (
    <>
      <KitSettingsGroup
        title="Time zone"
        footer="Your agents use it to know what time it is for you."
        data-testid="preferences-time-zone"
      >
        <KitSettingsRow
          label={<span data-testid="preferences-time-zone-value">{timeZone ? timeZoneLabel(timeZone) : "Not set"}</span>}
          description={<span data-testid="preferences-time-zone-mode">{description}</span>}
          control={
            loaded ? (
              <span className="flex flex-wrap justify-end items-center gap-2">
                <KitButton
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setPicking((p) => !p);
                    setQuery("");
                  }}
                  data-testid="preferences-time-zone-pick"
                >
                  {pinned ? "Change…" : "Pin…"}
                </KitButton>
                {pinned && (
                  <KitButton
                    size="sm"
                    variant="plain"
                    disabled={busy}
                    busy={busy && !picking}
                    onClick={() => void unpin()}
                    data-testid="preferences-time-zone-unpin"
                  >
                    Unpin
                  </KitButton>
                )}
              </span>
            ) : null
          }
        />
        {picking && (
          <KitSettingsRow
            stacked
            label="Pick a time zone to pin"
            data-testid="preferences-time-zone-picker"
            control={
              <div className="flex flex-col gap-2 w-full">
                <KitSearch
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search time zones"
                  autoFocus
                  data-testid="preferences-time-zone-search"
                />
                <div
                  role="listbox"
                  aria-label="Time zones"
                  className="max-h-[260px] overflow-y-auto rounded-[10px] border border-[var(--k-hair)]"
                >
                  {shown.length === 0 ? (
                    <div className="px-3 py-2 text-[13px] text-[var(--k-t3)]">No time zone matches.</div>
                  ) : (
                    shown.map((z) => (
                      <button
                        key={z}
                        type="button"
                        role="option"
                        aria-selected={z === timeZone}
                        disabled={busy}
                        onClick={() => void pin(z)}
                        data-testid="preferences-time-zone-option"
                        className="block w-full text-left px-3 py-1.5 text-[13.5px] text-[var(--k-t1)] hover:bg-white/[0.06] aria-selected:font-semibold disabled:opacity-50"
                      >
                        {timeZoneLabel(z)}
                      </button>
                    ))
                  )}
                </div>
                <span className="flex justify-end">
                  <KitButton
                    size="sm"
                    variant="plain"
                    disabled={busy}
                    onClick={() => setPicking(false)}
                    data-testid="preferences-time-zone-cancel"
                  >
                    Cancel
                  </KitButton>
                </span>
              </div>
            }
          />
        )}
      </KitSettingsGroup>
      {error !== null && (
        <KitBanner tone="danger" className="-mt-2 mb-5" data-testid="preferences-time-zone-error">
          {error}
        </KitBanner>
      )}
    </>
  );
}
