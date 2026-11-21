// The menu on an open relay room's pill — the room's sidebar menu (Rename…,
// Move to, Leave) plus what a pane handle adds (Move to new tab, Close),
// mirroring a conversation pill's menu. Desktop-only items follow the
// conversation pill: on a phone the pane IS the screen.

import { useMemo, useState, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { specForTab, encodeWorkspaceSpec } from "@/lib/tab-url";
import {
  patchRoomPinned,
  patchRoomProjectAssignment,
  useHostTree,
  useProjects,
  useRoomPinned,
  useRoomProjectSlug,
} from "@/state/conversation-store";
import { orderProjectsAsTree } from "@/state/project-tree";
import { useViewingUserMxid } from "@/state/viewing-user-store";
import { setRelayRoomPinned, setRelayRoomProject } from "@/api/session-project-api";
import {
  confirmAndLeaveRelayRoom,
  promptAndRenameRelayRoom,
} from "@/features/pretty-conversations/relay-room-row-actions";
import type {
  RowKebabMenuItem,
  RowKebabSubmenuItem,
} from "@/features/pretty-conversations/RowKebabMenu";
import { CreateProjectModal } from "@/features/pretty-conversations/CreateProjectModal";

/** File a room in a project (or take it out), as the sidebar does. Filing unpins it. */
function moveRoomToProject(a: {
  roomId: string;
  slug: string | null;
  viewingUserMxid: string | null;
}): void {
  const { roomId, slug, viewingUserMxid } = a;
  if (!viewingUserMxid) {
    console.warn(`[room-pill-menu] skipping move — viewing user mxid not yet resolved (roomId=${roomId})`);
    return;
  }
  console.info(`[room-pill-menu] move slug=${slug ?? "(null)"} roomId=${roomId}`);
  const rollback = patchRoomProjectAssignment(roomId, slug);
  setRelayRoomProject(roomId, viewingUserMxid, slug).catch((err: unknown) => {
    rollback();
    console.error(
      `[room-pill-menu] setRelayRoomProject failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/** Pin or unpin a room, as the sidebar does. Pinning takes it out of its project. */
function setRoomPinned(a: {
  roomId: string;
  pinned: boolean;
  viewingUserMxid: string | null;
}): void {
  const { roomId, pinned, viewingUserMxid } = a;
  if (!viewingUserMxid) {
    console.warn(`[room-pill-menu] skipping pin — viewing user mxid not yet resolved (roomId=${roomId})`);
    return;
  }
  console.info(`[room-pill-menu] pinned=${pinned} roomId=${roomId}`);
  const rollback = patchRoomPinned(roomId, pinned);
  setRelayRoomPinned(roomId, viewingUserMxid, pinned).catch((err: unknown) => {
    rollback();
    console.error(
      `[room-pill-menu] setRelayRoomPinned failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

export function useRelayRoomPaneMenu(args: {
  tabId: string;
  roomId: string;
  title: string | null;
  onCloseTab?: (id: string) => void;
}): { items: RowKebabMenuItem[]; modals: ReactNode } {
  const { tabId, roomId, title, onCloseTab } = args;
  const isMobile = useIsMobile();
  const roomPinned = useRoomPinned(roomId);
  const projects = useProjects();
  const assigned = useRoomProjectSlug(roomId);
  const viewingUserMxid = useViewingUserMxid();
  const hostTree = useHostTree();
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // Never the room's id: before its name is known, "this room".
  const shownTitle = title && title.length > 0 ? title : "this room";
  const live = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  // A tag naming no known project doesn't count — same as the sidebar.
  const currentProjectSlug = assigned !== null && live.some((p) => p.slug === assigned) ? assigned : null;
  // In a project outranks the pin, as in the sidebar.
  const shownPinned = roomPinned && currentProjectSlug === null;

  const items = useMemo<RowKebabMenuItem[]>(() => {
    const out: RowKebabMenuItem[] = [];

    if (!isMobile) {
      const spec = specForTab({ type: "terminal", sessionKind: "relay-room", relayRoomId: roomId });
      if (spec !== null) {
        out.push({
          label: "Move to new tab",
          onClick: () => {
            const payload = encodeWorkspaceSpec({ tabs: [spec], activeIndex: 0, only: true });
            const w = window.open("#" + payload, "_blank");
            // Popup blocked → keep the room here.
            if (w !== null) onCloseTab?.(tabId);
          },
        });
      }
    }

    out.push({
      label: "Rename…",
      onClick: () => promptAndRenameRelayRoom({ roomId, currentTitle: shownTitle }),
    });

    const setProject = (slug: string | null) =>
      moveRoomToProject({ roomId, slug, viewingUserMxid });
    // Same entries as the room's sidebar menu: Pinned, projects, New
    // project…, then Unpin or Remove from project.
    const submenu: RowKebabSubmenuItem[] = [];
    submenu.push({
      label: "Pinned",
      checked: shownPinned,
      onClick: () => {
        if (!shownPinned) setRoomPinned({ roomId, pinned: true, viewingUserMxid });
      },
    });
    for (const { project: p, depth } of orderProjectsAsTree(live)) {
      const isCurrent = p.slug === currentProjectSlug;
      submenu.push({
        label: p.displayName,
        checked: isCurrent,
        indent: depth,
        onClick: () => {
          if (!isCurrent) setProject(p.slug);
        },
      });
    }
    submenu.push({ label: "New project…", onClick: () => setNewProjectOpen(true) });
    if (shownPinned) {
      submenu.push({
        label: "Unpin",
        onClick: () => setRoomPinned({ roomId, pinned: false, viewingUserMxid }),
      });
    } else if (currentProjectSlug !== null) {
      submenu.push({ label: "Remove from project", onClick: () => setProject(null) });
    }
    out.push({ label: "Move to", submenu });

    out.push({
      label: "Leave",
      danger: true,
      onClick: () => confirmAndLeaveRelayRoom({ roomId, title: shownTitle }),
    });

    if (!isMobile && onCloseTab) {
      out.push({ label: "Close", onClick: () => onCloseTab(tabId) });
    }
    return out;
  }, [
    isMobile,
    roomId,
    tabId,
    shownTitle,
    onCloseTab,
    viewingUserMxid,
    shownPinned,
    live,
    currentProjectSlug,
  ]);

  const modals = (
    <CreateProjectModal
      open={newProjectOpen}
      onOpenChange={setNewProjectOpen}
      onCreated={({ slug }) => {
        console.info({ operation: "room_pill_new_project_created", roomId, slug });
        moveRoomToProject({ roomId, slug, viewingUserMxid });
      }}
      hostTree={hostTree}
    />
  );

  return { items, modals };
}
