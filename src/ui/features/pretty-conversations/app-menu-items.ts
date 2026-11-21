import { archiveApp } from "../../api/apps-archive-api";
import { encodeWorkspaceSpec, specForTab } from "../../lib/tab-url";
import { renameApp, validateAppTitle } from "../../api/apps-rename-api";
import { requestAppMove, type AppMoveDestination } from "../../api/apps-move-api";
import {
  publishAppGone,
  markPendingAppArchive,
  clearPendingAppArchive,
  setPendingAppTitle,
  clearPendingAppTitle,
  setPendingAppMove,
  clearPendingAppMove,
} from "../../state/app-tiles-store";
import type { RowKebabMenuItem, RowKebabSubmenuItem } from "./RowKebabMenu";
import type { AppMoveProject } from "../apps/use-app-move-projects";
import { kitAlert, kitConfirm, kitPrompt } from "@/components/kit";
import { openAppShareWindow } from "../sharing/AppShareWindow";

// ─── App menu items — shared by the sidebar AppTile and the AppPane bar ─────
//
// The per-app actions (Open in new tab, Open standalone, Rename…, Archive)
// live here so the sidebar tile's kebab and an open app pane's bar kebab
// offer the same actions with the same copy and side effects. Each surface
// adds its own placement-specific items around these — the bar swaps Open in
// new tab for Move to new tab (opens, then closes that pane) and adds
// Close. Same open/move split as conversation rows vs. badges.
//
// `hostId` is the wire string (AppState.hostId); the API clients take a
// number, cast at the boundary.

export interface AppMenuTarget {
  hostId: string;
  slug: string;
  title: string;
}

/** Opens the app as the only pane of a new Skynet window. null = popup
 *  blocked (or no spec), so callers never tear down a pane on failure. */
export function openAppInNewWindow(hostId: number, slug: string): Window | null {
  const spec = specForTab({ type: "app", app: { hostId, slug } });
  if (spec === null) return null;
  return window.open(
    "#" + encodeWorkspaceSpec({ tabs: [spec], activeIndex: 0, only: true }),
    "_blank",
  );
}

export interface AppMenuItems {
  /** Desktop-only — callers gate on isMobile (no multi-window on a phone).
   *  Leaves any panes already showing the app alone: an app can back
   *  several panes at once. */
  openInNewWindow: RowKebabMenuItem;
  openStandalone: RowKebabMenuItem;
  /** Sidebar apps on a machine more than one person uses — callers gate on
   *  both (useMultiUserMachine, !app.owner). Opens the Share window. */
  share: RowKebabMenuItem;
  rename: RowKebabMenuItem;
  archive: RowKebabMenuItem;
}

/** Where an app is now, as the sweep reports it. */
export interface AppScopeTarget extends AppMenuTarget {
  owner?: string | null;
  project?: string | null;
}

/**
 * project-scoped apps: move an app to the sidebar or a project. Shown in its
 * new place at once (setPendingAppMove); the machine carries the move out on
 * its next tick. A refused request puts it back and says why.
 */
export async function moveApp(app: AppScopeTarget, dest: AppMoveDestination): Promise<void> {
  const previous = { owner: app.owner ?? null, project: app.project ?? null };
  setPendingAppMove(app.hostId, app.slug, dest.to === "project" ? dest.project : null);
  try {
    await requestAppMove(Number(app.hostId), app.slug, dest);
  } catch (err) {
    clearPendingAppMove(app.hostId, app.slug, previous);
    const errMessage = err instanceof Error ? err.message : String(err);
    console.warn({
      operation: "app_move_request_failed",
      hostId: Number(app.hostId),
      slug: app.slug,
      to: dest.to === "project" ? `project:${dest.project}` : "sidebar",
      errMessage,
    });
    void kitAlert({ title: `Couldn't move "${app.title}"`, body: errMessage });
  }
}

/**
 * project-scoped apps: the "Move to" drill-in for any app's menu — Sidebar,
 * then every project on the app's machine (indented as in the sidebar), with
 * a check on where it is now. A conversation app has no check (nothing moves
 * into a conversation). Picking where it already is does nothing.
 */
export function buildAppMoveToItem(
  app: AppScopeTarget,
  projects: readonly AppMoveProject[],
): RowKebabMenuItem {
  const owner = app.owner ?? null;
  const project = owner === null ? (app.project ?? null) : null;
  const inSidebar = owner === null && project === null;
  const submenu: RowKebabSubmenuItem[] = [
    {
      label: "Sidebar",
      checked: inSidebar,
      testId: "app-menu-move-to-sidebar",
      onClick: () => {
        if (!inSidebar) void moveApp(app, { to: "sidebar" });
      },
    },
    ...projects.map((p) => ({
      label: p.displayName,
      indent: p.depth,
      checked: project === p.slug,
      testId: `app-menu-move-to-project-${p.slug}`,
      onClick: () => {
        if (project !== p.slug) void moveApp(app, { to: "project", project: p.slug });
      },
    })),
  ];
  return { label: "Move to", submenu, testId: "app-menu-item-move-to" };
}

export function buildAppMenuItems(
  app: AppMenuTarget,
  // Fired after the user confirms Archive, once the tile is optimistically
  // dropped and BEFORE the awaited archiveApp resolves, so the parent can
  // close every open pane for this app in the same beat as the tile vanishes.
  onArchive?: (hostId: number, slug: string, title: string) => void,
): AppMenuItems {
  // Defensive encodeURIComponent on both segments — APP_SLUG_RE gates the
  // wire today, but encoding here means a future widening can't expose an
  // unencoded interpolation from this surface.
  const openUrl = `/apps/${encodeURIComponent(app.hostId)}/${encodeURIComponent(app.slug)}`;

  return {
    openInNewWindow: {
      label: "Open in new tab",
      testId: "app-menu-item-open-new-window",
      onClick: () => {
        openAppInNewWindow(Number(app.hostId), app.slug);
      },
    },
    // The app on its own in a browser tab — no Skynet around it.
    openStandalone: {
      label: "Open standalone",
      testId: "app-menu-item-open-standalone",
      onClick: () => {
        // Tabnabbing guard: no window.opener, no Referer.
        window.open(openUrl, "_blank", "noopener,noreferrer");
      },
    },
    share: {
      label: "Share…",
      testId: "app-menu-item-share",
      onClick: () => {
        openAppShareWindow({ hostId: Number(app.hostId), slug: app.slug, title: app.title });
      },
    },
    // app-rename shape — title only (the slug is the app's identity). Kit
    // prompt; an invalid entry shows its error under the field and keeps the
    // user's text until it validates or they cancel. Sidebar
    // update: OPTIMISTIC via setPendingAppTitle (the store keeps the new
    // title over stale fleet-status frames until the sweep re-reads
    // app.json); rolled back via clearPendingAppTitle on failure.
    rename: {
      label: "Rename…",
      testId: "app-menu-item-rename",
      onClick: async () => {
        const previousTitle = app.title;
        const input = await kitPrompt({
          title: `Rename "${previousTitle}"`,
          defaultValue: previousTitle,
          confirmLabel: "Rename",
          validate: (raw) => {
            const v = validateAppTitle(raw);
            return v.ok ? null : v.error;
          },
        });
        if (input === null) return;
        const v = validateAppTitle(input);
        if (!v.ok) return;
        const title = v.title;
        if (title === previousTitle) return;

        setPendingAppTitle(app.hostId, app.slug, title);
        try {
          await renameApp(Number(app.hostId), app.slug, title);
        } catch (err) {
          clearPendingAppTitle(app.hostId, app.slug, previousTitle);
          const errMessage = err instanceof Error ? err.message : String(err);
          console.warn({
            operation: "app_rename_failed",
            hostId: Number(app.hostId),
            slug: app.slug,
            errMessage,
          });
          void kitAlert({ title: `Couldn't rename "${previousTitle}"`, body: errMessage });
        }
      },
    },
    // app-archive shape — danger-styled, placed LAST by every caller (most
    // destructive at bottom, same as identity/role archive). Double-confirm
    // ceremony. Sidebar update: OPTIMISTIC via markPendingAppArchive +
    // publishAppGone — mirrors identity-archive's optimistic-remove.
    archive: {
      label: "Archive",
      danger: true,
      testId: "app-menu-item-archive",
      onClick: async () => {
        if (
          !(await kitConfirm({
            title: `Archive "${app.title}"?`,
            body: "It leaves the sidebar and stops being served. You can't undo this here.",
            confirmLabel: "Archive",
            destructive: true,
          }))
        )
          return;
        if (
          !(await kitConfirm({
            title: "Are you sure?",
            body: `"${app.title}" will be archived. You can't undo this here.`,
            confirmLabel: "Archive",
            destructive: true,
          }))
        )
          return;
        // Mark pending FIRST so any in-flight fleet-status app-update /
        // app-snapshot frame is silent-dropped rather than re-inserting it.
        markPendingAppArchive(app.hostId, app.slug);
        publishAppGone(app.hostId, app.slug);
        onArchive?.(Number(app.hostId), app.slug, app.title);
        // errMessage flows from handleApiError; the backend archive endpoint
        // redacts internal errors (generic 500 body), so the alert stays at
        // transport-level granularity. If that contract widens, review.
        try {
          await archiveApp(Number(app.hostId), app.slug);
        } catch (err) {
          // Rollback: the next fleet-status pulse re-inserts the tile. Closed
          // panes are NOT re-opened — the alert lets the user do it by hand.
          clearPendingAppArchive(app.hostId, app.slug);
          const errMessage = err instanceof Error ? err.message : String(err);
          console.warn({
            operation: "app_archive_failed",
            hostId: Number(app.hostId),
            slug: app.slug,
            errMessage,
          });
          void kitAlert({ title: `Couldn't archive "${app.title}"`, body: errMessage });
        }
      },
    },
  };
}
