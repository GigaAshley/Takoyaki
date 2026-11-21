// convo-scoped apps: app links and the "open this app" bridge.
//
// An agent hands an app to the user by linking its pane address,
// `<skynet-origin>/apps/<hostId>/<slug>/pane/`. The chat renders such a link
// as an app chip (AppChip); clicking it — or a row in the identity modal's
// Apps tab — asks the shell to open the app exactly like a sidebar tile click.
// The shell listens for OPEN_APP_EVENT (AppShell), so surfaces deep in the
// conversation tree don't need the shell's callbacks threaded down to them.

import type { AppState } from "@/api/fleet-status-types";

/** Drag MIME shared with sidebar app tiles — the split view already accepts it. */
export const APP_TILE_MIME = "application/x-skynet-app-tile";

export const OPEN_APP_EVENT = "skynet:open-app";

export interface AppAddress {
  hostId: number;
  slug: string;
}

export interface OpenAppDetail extends AppAddress {
  title: string;
}

const APP_PANE_PATH_RE = /^\/apps\/([1-9][0-9]{0,9})\/([a-z0-9-]{1,64})\/pane(?:\/.*)?$/;

/**
 * Parse an app pane link into its (hostId, slug). Accepts the same-origin
 * absolute form agents write and the root-relative form; anything else
 * (other origins, other paths) returns null and stays a plain link.
 */
export function parseSkynetAppUrl(href: string | undefined | null): AppAddress | null {
  if (!href) return null;
  let pathname: string;
  try {
    const u = new URL(href, window.location.origin);
    if (u.origin !== window.location.origin) return null;
    pathname = u.pathname;
  } catch {
    return null;
  }
  const m = APP_PANE_PATH_RE.exec(pathname);
  if (!m) return null;
  return { hostId: Number(m[1]), slug: m[2] };
}

/**
 * Fill a drag with one app — what the chat's app chip and the task pill's
 * apps button carry, so the split view opens the app in a pane. Clears any
 * other payload first (an anchor would add its URL as text).
 */
export function writeAppDragData(dt: DataTransfer, detail: OpenAppDetail): void {
  dt.clearData();
  dt.setData(APP_TILE_MIME, JSON.stringify({ hostId: detail.hostId, slug: detail.slug, title: detail.title }));
  dt.effectAllowed = "copy";
}

export function requestOpenApp(detail: OpenAppDetail): void {
  window.dispatchEvent(new CustomEvent<OpenAppDetail>(OPEN_APP_EVENT, { detail }));
}

/**
 * Find the app a link names among the apps this browser knows. A link's number
 * is the box's machine id (what agents write), while each known app carries
 * the viewer's own host row id — the same number for whoever added the box
 * first, a different one for anyone with their own row for it. Match the row
 * id first, then the machine id.
 */
export function findAppForLink(
  apps: readonly AppState[],
  address: AppAddress,
): AppState | undefined {
  const ref = String(address.hostId);
  const exact = apps.find((a) => a.hostId === ref && a.slug === address.slug);
  if (exact) return exact;
  // Several own rows for one machine (different SSH users): take the lowest
  // id, the row the server resolves the link to.
  let best: AppState | undefined;
  for (const a of apps) {
    if (a.machineId !== ref || a.slug !== address.slug) continue;
    if (!best || Number(a.hostId) < Number(best.hostId)) best = a;
  }
  return best;
}
