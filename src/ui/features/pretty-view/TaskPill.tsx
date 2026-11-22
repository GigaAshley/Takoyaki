// ─── TaskPill ────────────────────────────────────────────────────────────────
//
// The top-center handle of an agent conversation pane (chat view AND terminal
// view) — it replaced the identity badge. It looks and behaves like that
// conversation's sidebar row:
//   - avatar + task (agent name when there is no task), same as the row
//   - click → the agent window (IdentityModal)
//   - ⋮ and right-click → the conversation menu (the same items the badge had)
//   - drag → the pane handle (drop lane, split rearrange, other windows,
//     filing into sidebar sections) — desktop only
//   - hover → tooltip with the full task, then name, roles, project
//   - just before the ⋮, the agent memory pie (not on archived agents) — tap
//     for how full it is and Compact conversation
//
// Beside it, outside the pill, round buttons appear only while their
// condition holds, each a shortcut into the agent window:
//   - desktop running (green) → Desktop tab
//   - the conversation has apps of its own (blue) → the app itself when
//     there's one, the Apps tab when there are several
//   - local work not pushed (amber) → Git tab
// The desktop button is also a drag source (desktop only): dragging it into
// the content area opens the desktop as its own split-view pane. So is the
// apps button while there's exactly one app: it drops that app in a pane,
// like dragging its chip.
// They hang off the pill's right edge so the pill stays centered whether or
// not they show, and the pill's width reserves room for all three so it never
// resizes when one appears.

import { type DragEvent as ReactDragEvent } from "react";
import { AppWindow, GitPullRequestDraft, Monitor } from "lucide-react";
import { useIdentities } from "@/state/identities-store";
import type { Identity } from "@/api/identities-api";
import { useProjects } from "@/state/conversation-store";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTrappedWork } from "@/state/trapped-work-store";
import { useSessionDesktopRunning } from "@/api/fleet-status-client";
import { useAppTiles } from "@/state/app-tiles-store";
import {
  hasNeutralLook,
  identityRolesLabel,
  identityTint,
  NEUTRAL_HUE,
} from "@/lib/identity-roles";
import { AvatarImage } from "@/components/avatar-image";
import { writeBadgeDragData, type BadgeDragSource } from "@/shell/badge-drag";
import { desktopOpensFullScreen, requestDesktopPane, writeDesktopDragData } from "@/shell/desktop-drag";
import type { RowKebabMenuItem } from "@/features/pretty-conversations/RowKebabMenu";
import { isCoarsePointer } from "@/features/pretty-conversations/row-touch-gestures";
import { MemoryGauge } from "./MemoryGauge";
import { PILL_SIDE_BUTTON_PX, PillFrame } from "./PillFrame";
import { useAgentCondense } from "./use-agent-condense";
import { conversationAppsFor } from "./AppsTab";
import { requestOpenApp, writeAppDragData } from "../apps/app-link";

/** Agent-window tabs the round buttons jump to. */
export type TaskPillJumpTab = "desktop" | "apps" | "git";

export interface TaskPillProps {
  identityKey: string;
  hostId: number;
  /** The pane's tmux session — keys the live desktop-running signal. */
  tmuxSession: string | null;
  /** The machine's name — a failed Compact names it. */
  hostName?: string;
  /** Pane tab id; absent → not a drag source. */
  tabId?: string;
  dragDescriptor?: BadgeDragSource["descriptor"];
  menuItems: RowKebabMenuItem[];
  /** Open the agent window, optionally on a specific tab. */
  onOpen: (tab?: TaskPillJumpTab) => void;
  /** An archived agent (not in the identities registry): paint this look,
   *  and show no round buttons — nothing is running. */
  identity?: Identity;
}

export function TaskPill({
  identityKey,
  hostId,
  tmuxSession,
  hostName,
  tabId,
  dragDescriptor,
  menuItems,
  onOpen,
  identity: archivedIdentity,
}: TaskPillProps) {
  const { byKey, byHostKey } = useIdentities();
  const nameLc = identityKey.toLowerCase();
  const identity =
    archivedIdentity ??
    (Number.isFinite(hostId)
      ? (byHostKey?.get(`${hostId}::${nameLc}`) ?? byKey.get(nameLc))
      : byKey.get(nameLc));
  const isMobile = useIsMobile();
  // Touch screens drag nothing — a press-and-hold there opens the menu.
  const isDragSource = !!tabId && !isMobile && !isCoarsePointer();
  const trappedWork = useTrappedWork(identityKey, hostId);
  const desktopRunning = useSessionDesktopRunning(hostId, tmuxSession);
  const memory = useAgentCondense(hostId, identityKey, tmuxSession, hostName);
  const allApps = useAppTiles();
  const projects = useProjects();

  if (!identity) return null;

  // An identity with no roles and no colorHue paints in the neutral grey.
  const neutralLook = hasNeutralLook(identity);
  const tint = identityTint(identity.colorHue ?? (neutralLook ? NEUTRAL_HUE : 35), neutralLook);
  const label = identity.task || identity.displayName || identity.identityKey;
  const roles = identityRolesLabel(identity);
  const projectName = identity.project
    ? (projects.find(
        (p) => p.slug === identity.project && p.hostId === String(identity.hostId),
      )?.displayName ?? null)
    : null;
  // The full task first (the pill cuts it off when space is tight), then who
  // the agent is.
  const tooltip = [
    identity.task,
    [identity.displayName, [roles, projectName].filter(Boolean).join(" · ")]
      .filter(Boolean)
      .join(" — "),
  ]
    .filter(Boolean)
    .join("\n");
  const hasUnpushed = trappedWork?.hasTrappedWork === true;
  const apps = conversationAppsFor(allApps, hostId, identity.identityKey);
  const soleApp = apps.length === 1 ? apps[0] : null;
  const soleAppDetail = soleApp
    ? { hostId: Number(soleApp.hostId), slug: soleApp.slug, title: soleApp.title || soleApp.slug }
    : null;

  const onDragStart = isDragSource
    ? (e: ReactDragEvent<HTMLElement>) => {
        const dragId = writeBadgeDragData(e.dataTransfer, {
          tabId: tabId!,
          identityKey,
          hostId,
          descriptor: dragDescriptor ?? null,
        });
        console.info(`[task-pill-drag] tabId=${tabId} dragId=${dragId} hostId=${hostId}`);
      }
    : undefined;

  // Desktop button drag → a desktop pane (a copy gesture; the button stays).
  const onDesktopDragStart =
    isMobile || !Number.isFinite(hostId)
    ? undefined
    : (e: ReactDragEvent<HTMLElement>) => {
        e.stopPropagation();
        writeDesktopDragData(e.dataTransfer, {
          hostId,
          identityKey: identity.identityKey.toLowerCase(),
          label: identity.displayName || identity.identityKey,
        });
        console.info(
          `[task-pill-desktop-drag] start hostId=${hostId} identityKey=${identity.identityKey}`,
        );
      };

  // Apps button drag (one app only) → that app in a pane, same payload as its chip.
  const onAppDragStart =
    soleAppDetail && !isMobile
      ? (e: ReactDragEvent<HTMLElement>) => {
          e.stopPropagation();
          writeAppDragData(e.dataTransfer, soleAppDetail);
          console.info(
            `[task-pill-app-drag] start hostId=${soleAppDetail.hostId} slug=${soleAppDetail.slug} identityKey=${identity.identityKey}`,
          );
        }
      : undefined;

  const open = (tab?: TaskPillJumpTab) => {
    console.info(
      `[task-pill] open hostId=${hostId} identityKey=${identityKey} tab=${tab ?? "default"}`,
    );
    // A phone opens the desktop full screen, skipping the agent window.
    if (tab === "desktop" && identity && Number.isFinite(hostId) && desktopOpensFullScreen()) {
      requestDesktopPane({
        hostId,
        identityKey: identity.identityKey.toLowerCase(),
        label: identity.displayName || identity.identityKey,
      });
      return;
    }
    onOpen(tab);
  };

  const openApps = () => {
    if (!soleAppDetail) {
      open("apps");
      return;
    }
    console.info(
      `[task-pill] open app hostId=${soleAppDetail.hostId} slug=${soleAppDetail.slug} identityKey=${identityKey}`,
    );
    requestOpenApp(soleAppDetail);
  };

  return (
    <PillFrame
      tooltip={tooltip}
      onOpen={() => open()}
      openAriaLabel="Open agent info"
      menuItems={menuItems}
      menuAriaLabel="Agent menu"
      onDragStart={onDragStart}
      picture={
        <AvatarImage
          src={identity.avatarUrl}
          name={identity.displayName}
          className="shrink-0 object-cover"
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            boxShadow: `0 0 0 1.5px ${tint(60, 60, 0.55)}`,
          }}
          initialClassName="shrink-0 inline-flex items-center justify-center font-semibold"
          initialStyle={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            fontSize: 12,
            background: tint(45, 35, 0.9),
            boxShadow: `0 0 0 1.5px ${tint(60, 60, 0.55)}`,
          }}
        />
      }
      label={label}
      beforeMenu={(narrow) =>
        !archivedIdentity && (
          // The memory pie keeps its own taps: a click (or one inside its
          // pop-over, which bubbles here through the portal) never opens the
          // agent window, a hold never opens the pill's menu, and a
          // press-and-move never drags the pane. Right-click on the pie still
          // reaches the pill's menu.
          <span
            className="pv-pill-mem shrink-0 inline-flex"
            data-testid="pv-task-pill-memory"
            draggable
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) e.stopPropagation();
            }}
          >
            <MemoryGauge
              pct={memory.pct}
              condensing={memory.condensing}
              compact={narrow}
              condenseDisabled={memory.inFlight}
              onCondense={() => {
                void memory.condense();
              }}
            />
          </span>
        )
      }
      side={
        !archivedIdentity && (desktopRunning || apps.length > 0 || hasUnpushed) && (
        <div
          data-testid="pv-task-pill-side"
          className="absolute top-1/2 -translate-y-1/2 flex flex-row gap-2"
          style={{ left: "calc(100% + 8px)" }}
        >
          {desktopRunning && (
            <SideButton
              testId="pv-desktop-button"
              label={
                onDesktopDragStart
                  ? "Desktop running — click to open it, or drag it beside the conversation"
                  : "Desktop running — open it"
              }
              hue={150}
              onClick={() => open("desktop")}
              onDragStart={onDesktopDragStart}
            >
              <Monitor width={16} height={16} aria-hidden="true" />
            </SideButton>
          )}
          {apps.length > 0 && (
            <SideButton
              testId="pv-apps-button"
              label={
                soleAppDetail
                  ? onAppDragStart
                    ? `Open ${soleAppDetail.title} — or drag it beside the conversation`
                    : `Open ${soleAppDetail.title}`
                  : "Open this conversation's apps"
              }
              hue={212}
              onClick={openApps}
              onDragStart={onAppDragStart}
            >
              <AppWindow width={16} height={16} aria-hidden="true" />
            </SideButton>
          )}
          {hasUnpushed && (
            <SideButton
              testId="pv-unpushed-button"
              label="Local work not yet pushed to any remote — open Git"
              hue={35}
              onClick={() => open("git")}
            >
              <GitPullRequestDraft width={16} height={16} aria-hidden="true" />
            </SideButton>
          )}
        </div>
      )
      }
    />
  );
}

function SideButton({
  testId,
  label,
  hue,
  onClick,
  onDragStart,
  children,
}: {
  testId: string;
  label: string;
  hue: number;
  onClick: () => void;
  /** Present → the button is a drag source. */
  onDragStart?: (e: ReactDragEvent<HTMLElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      // Pulses on appearing (it mounts when its condition turns true), then
      // holds a steady color.
      className="pv-side-button shrink-0 inline-flex items-center justify-center cursor-pointer transition-transform hover:scale-[1.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      style={
        {
          "--pv-side-hue": hue,
          width: PILL_SIDE_BUTTON_PX,
          height: PILL_SIDE_BUTTON_PX,
          borderRadius: "50%",
          color: "#f4fff8",
          background: `linear-gradient(160deg, hsla(${hue}, 50%, 32%, 0.88), hsla(${hue}, 45%, 20%, 0.92))`,
          border: `1px solid hsla(${hue}, 65%, 52%, 0.6)`,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 18px rgba(0,0,0,0.45)`,
        } as React.CSSProperties
      }
    >
      {children}
    </button>
  );
}
