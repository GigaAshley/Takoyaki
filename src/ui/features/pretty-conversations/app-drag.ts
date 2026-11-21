// app-drag — the sidebar app being dragged (project-scoped apps).
//
// An Apps-grid tile or a project app row carries the app-tile payload, which
// the content area opens as a pane. Dropped on a project's section it moves
// the app into that project; dropped on the Apps section it moves the app to
// the sidebar. During dragover the browser hides dataTransfer contents, so
// the dragged app is also held here for the duration of the drag — drop
// targets need it to decide whether to light up (another machine's project,
// or where the app already is, never does). Only sidebar drags set it, so an
// app chip dragged out of a chat only ever opens a pane.

import { APP_TILE_MIME } from "../apps/app-link";

export interface DraggedApp {
  hostId: string;
  slug: string;
  title: string;
  owner: string | null;
  project: string | null;
}

let current: DraggedApp | null = null;
let windowListening = false;

// A drop can re-render the source so its own dragend never arrives; any
// drag ending anywhere clears the held app (after this drop's handlers ran),
// so a later chip drag can't pick up a stale app.
function clearSoon(): void {
  setTimeout(() => {
    current = null;
  }, 0);
}

export function startAppDrag(dt: DataTransfer, app: DraggedApp): void {
  current = app;
  if (!windowListening && typeof window !== "undefined") {
    windowListening = true;
    window.addEventListener("dragend", clearSoon, true);
    window.addEventListener("drop", clearSoon, true);
  }
  dt.setData(APP_TILE_MIME, JSON.stringify({ hostId: Number(app.hostId), slug: app.slug, title: app.title }));
  // copy: opens a new pane; move: files it in a project / the Apps section.
  dt.effectAllowed = "copyMove";
}

export function endAppDrag(): void {
  current = null;
}

/** The sidebar app being dragged right now, or null. */
export function getDraggedApp(): DraggedApp | null {
  return current;
}

/**
 * The held app, only if it is the one this drop carries (its payload names
 * the same machine and app) — never act on a stale one.
 */
export function droppedApp(dt: DataTransfer | null | undefined): DraggedApp | null {
  if (current === null || !dt) return null;
  try {
    const p = JSON.parse(dt.getData(APP_TILE_MIME)) as { hostId?: unknown; slug?: unknown };
    return String(p.hostId) === current.hostId && p.slug === current.slug ? current : null;
  } catch {
    return null;
  }
}

export function hasAppMime(dt: DataTransfer | null | undefined): boolean {
  return !!dt && Array.from(dt.types).includes(APP_TILE_MIME);
}
