// ProjectAppRow — one project app in its project's sidebar section
// (project-scoped apps). Sits between the project's sub-projects and its
// conversations and looks like a conversation row: the app's icon and title
// on one line on desktop; title over description on a phone.
//
//   - Click opens the app (same as an Apps-grid tile).
//   - Drag (desktop) carries the app-tile payload: into the content area it
//     opens the app in a split, onto another project or the Apps section it
//     moves the app there.
//   - Its menu (⋮, right-click, press-and-hold) is the app's menu: Open in new
//     tab (desktop), Open standalone, Rename…, Move to. A project app has no
//     share or archive of its own — it goes with its project.

import { useCallback, useEffect, useState, type DragEvent as ReactDragEvent } from "react";
import { AppWindow } from "lucide-react";

import type { AppState } from "../../api/fleet-status-types";
import { cn } from "@/lib/utils";
import { appIconUrl } from "./app-icon-url";
import { buildAppMenuItems, buildAppMoveToItem } from "./app-menu-items";
import { useAppMoveProjects } from "../apps/use-app-move-projects";
import { endAppDrag, startAppDrag } from "./app-drag";
import { RowKebabMenu, useRowKebabContextMenu, type RowKebabMenuItem } from "./RowKebabMenu";
import { isCoarsePointer, useRowTouchGestures } from "./row-touch-gestures";

export interface ProjectAppRowProps {
  app: AppState;
  onOpenApp?: (hostId: number, slug: string, title: string) => void;
  variant: "mobile" | "desktop";
}

export function ProjectAppRow({ app, onOpenApp, variant }: ProjectAppRowProps): React.ReactElement {
  const isMobile = variant === "mobile";
  const [imgFailed, setImgFailed] = useState(false);
  const iconUrl = appIconUrl(app.hostId, app.slug, app.iconVersion);
  useEffect(() => setImgFailed(false), [iconUrl]);
  const moveProjects = useAppMoveProjects(app.hostId);

  const open = useCallback(() => {
    onOpenApp?.(Number(app.hostId), app.slug, app.title);
  }, [app.hostId, app.slug, app.title, onOpenApp]);

  const onDragStart = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      startAppDrag(e.dataTransfer, {
        hostId: app.hostId,
        slug: app.slug,
        title: app.title,
        owner: app.owner ?? null,
        project: app.project ?? null,
      });
    },
    [app.hostId, app.slug, app.title, app.owner, app.project],
  );

  const menu = buildAppMenuItems(app);
  const items: RowKebabMenuItem[] = [
    ...(isMobile ? [] : [{ ...menu.openInNewWindow, testId: "pv-project-app-kebab-item-open-new-window" }]),
    { ...menu.openStandalone, testId: "pv-project-app-kebab-item-open-standalone" },
    { ...menu.rename, testId: "pv-project-app-kebab-item-rename" },
    { ...buildAppMoveToItem(app, moveProjects), testId: "pv-project-app-kebab-item-move-to" },
  ];
  const kebabContextMenu = useRowKebabContextMenu(items);
  const touch = useRowTouchGestures({ onHold: kebabContextMenu.openAt });

  return (
    <div className="relative" data-testid="pv-project-app-row" data-app-key={`${app.hostId}:${app.slug}`}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`App: ${app.title}`}
        title={app.isHealthy ? undefined : (app.healthMessage ?? "This app isn't working")}
        draggable={!isCoarsePointer()}
        onDragStart={onDragStart}
        onDragEnd={endAppDrag}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            kebabContextMenu.openAt(r.left + 24, r.bottom);
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        {...touch.handlers}
        onContextMenu={kebabContextMenu.onContextMenu}
        style={touch.style}
        className={cn(
          "group pv-row pv-app-row",
          isMobile ? "pv-row--mobile" : "pv-row--desktop",
          !app.isHealthy && "pv-app-row--unhealthy",
        )}
      >
        <div className="pv-avatar pv-app-row-icon" data-testid="pv-project-app-icon">
          {app.hasIcon && !imgFailed ? (
            <img src={iconUrl} alt="" className="pv-app-icon-img" onError={() => setImgFailed(true)} />
          ) : (
            <AppWindow className="pv-app-row-glyph" aria-hidden="true" />
          )}
        </div>
        <div className="pv-body">
          <span className="pv-label">
            {!app.isHealthy && <span aria-hidden="true">⚠ </span>}
            {app.title}
          </span>
          <span className="pv-ai-title">{app.description || " "}</span>
        </div>
        <div className="pv-row-kebab-slot">
          <RowKebabMenu ariaLabel={`${app.title} menu`} testId="pv-project-app-kebab-trigger" items={items} />
          {kebabContextMenu.menu}
        </div>
      </div>
    </div>
  );
}
