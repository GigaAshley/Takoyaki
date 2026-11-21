// An Apps tab: the apps that belong to one conversation (identity modal) or
// one project (project modal), so they can be found again. Clicking a row
// closes the modal and opens the app (same as a sidebar tile click). Each
// row's ⋮ holds Move to (the sidebar or a project). No drag, no rename, no
// archive — the app goes with its conversation or project.

import { useState } from "react";
import { AppWindow } from "lucide-react";
import type { AppState } from "@/api/fleet-status-types";
import { KitSettingsGroup, KitSettingsRow } from "@/components/kit";
import { appIconUrl } from "../pretty-conversations/app-icon-url";
import { buildAppMoveToItem } from "../pretty-conversations/app-menu-items";
import { RowKebabMenu } from "../pretty-conversations/RowKebabMenu";
import { requestOpenApp } from "../apps/app-link";
import { useAppMoveProjects } from "../apps/use-app-move-projects";

/** The apps owned by one identity on one host, in the store's sort order. */
export function conversationAppsFor(
  apps: AppState[],
  hostId: number,
  identityKey: string | null | undefined,
): AppState[] {
  if (!identityKey) return [];
  const key = identityKey.toLowerCase();
  return apps.filter((a) => a.hostId === String(hostId) && a.owner?.toLowerCase() === key);
}

/** project-scoped apps: the apps of one project on one host, in the store's sort order. */
export function projectAppsFor(apps: AppState[], hostId: number | string, projectSlug: string): AppState[] {
  return apps.filter((a) => a.hostId === String(hostId) && !a.owner && a.project === projectSlug);
}

export interface AppsTabProps {
  apps: AppState[];
  /** Close the modal (before the app opens behind it). */
  onClose: () => void;
  testId?: string;
}

export function AppsTab({ apps, onClose, testId = "identity-apps-tab" }: AppsTabProps) {
  return (
    <KitSettingsGroup data-testid={testId}>
      {apps.map((app) => (
        <AppsTabRow key={`${app.hostId}/${app.slug}`} app={app} onClose={onClose} />
      ))}
    </KitSettingsGroup>
  );
}

function AppsTabRow({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const moveProjects = useAppMoveProjects(app.hostId);
  const open = () => {
    onClose();
    requestOpenApp({ hostId: Number(app.hostId), slug: app.slug, title: app.title });
  };
  return (
    <KitSettingsRow
      data-testid="identity-apps-row"
      leading={
        app.hasIcon && !imgFailed ? (
          <img
            src={appIconUrl(app.hostId, app.slug, app.iconVersion)}
            alt=""
            className="size-[34px] shrink-0 rounded-[9px]"
            draggable={false}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="size-[34px] shrink-0 rounded-[9px] bg-[var(--k-s3)] grid place-items-center text-[var(--k-t2)]">
            <AppWindow className="size-4" aria-hidden />
          </span>
        )
      }
      label={<span className="font-semibold">{app.title}</span>}
      description={app.description || undefined}
      truncate
      openLabel={`Open ${app.title}`}
      onClick={open}
      chevron={false}
      control={
        <RowKebabMenu
          ariaLabel={`${app.title} menu`}
          testId="identity-apps-row-kebab"
          items={[buildAppMoveToItem(app, moveProjects)]}
        />
      }
    />
  );
}
