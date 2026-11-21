// The menu on an open relay room's pill — the room's sidebar menu (Rename…,
// Move to, Leave) plus what a pane handle adds (Move to new tab, Close),
// mirroring a conversation pill's menu. Desktop-only items follow the
// conversation pill: on a phone the pane IS the screen.

import { useMemo, useState, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { specForTab, encodeWorkspaceSpec } from "@/lib/tab-url";
import {
  patchRoomProjectAssignment,
  pinConversation,
  unpinConversation,
  useHostTree,
  usePinnedIds,
  useProjects,
  useRoomProjectSlug,
} from "@/state/conversation-store";
import { orderProjectsAsTree } from "@/state/project-tree";
import { useViewingUserMxid } from "@/state/viewing-user-store";
import { setRelayRoomProject } from "@/api/session-project-api";
import {
  confirmAndLeaveRelayRoom,
  promptAndRenameRelayRoom,
} from "@/features/pretty-conversations/relay-room-row-actions";
import type {
  RowKebabMenuItem,
  RowKebabSubmenuItem,
} from "@/features/pretty-conversations/RowKebabMenu";
import { CreateProjectModal } from "@/features/pretty-conversations/CreateProjectModal";

export function useRelayRoomPaneMenu(args: {
  tabId: string;
  roomId: string;
  title: string | null;
  onCloseTab?: (id: string) => void;
}): { items: RowKebabMenuItem[]; modals: ReactNode } {
  const { tabId, roomId, title, onCloseTab } = args;
  const isMobile = useIsMobile();
  const pinnedIds = usePinnedIds();
  const projects = useProjects();
  const assigned = useRoomProjectSlug(roomId);
  const viewingUserMxid = useViewingUserMxid();
  const hostTree = useHostTree();
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const shownTitle = title && title.length > 0 ? title : roomId;
  const live = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  // A tag naming no known project doesn't count — same as the sidebar.
  const currentProjectSlug = assigned !== null && live.some((p) => p.slug === assigned) ? assigned : null;
  const isPinned = pinnedIds.has(tabId);
  const shownPinned = isPinned && currentProjectSlug === null;

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

    const setProject = (slug: string | null) => {
      if (!viewingUserMxid) {
        console.warn(`[room-pill-menu] skipping move — viewing user mxid not yet resolved (roomId=${roomId})`);
        return;
      }
      console.info(`[room-pill-menu] move slug=${slug ?? "(null)"} roomId=${roomId}`);
      if (slug !== null && pinnedIds.has(tabId)) unpinConversation(tabId);
      const rollback = patchRoomProjectAssignment(roomId, slug);
      setRelayRoomProject(roomId, viewingUserMxid, slug).catch((err: unknown) => {
        rollback();
        console.error(
          `[room-pill-menu] setRelayRoomProject failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };
    const submenu: RowKebabSubmenuItem[] = [
      {
        label: "Pinned",
        checked: shownPinned,
        onClick: () => {
          if (shownPinned) return;
          // Pinned and in-a-project are exclusive: pinning leaves the project.
          if (currentProjectSlug !== null) setProject(null);
          if (!isPinned) pinConversation(tabId);
        },
      },
    ];
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
      submenu.push({ label: "Unpin", onClick: () => unpinConversation(tabId) });
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
    pinnedIds,
    live,
    currentProjectSlug,
    shownPinned,
    isPinned,
  ]);

  const modals = (
    <CreateProjectModal
      open={newProjectOpen}
      onOpenChange={setNewProjectOpen}
      onCreated={({ slug }) => {
        console.info({ operation: "room_pill_new_project_created", roomId, slug });
        if (!viewingUserMxid) return;
        if (pinnedIds.has(tabId)) unpinConversation(tabId);
        const rollback = patchRoomProjectAssignment(roomId, slug);
        setRelayRoomProject(roomId, viewingUserMxid, slug).catch(() => rollback());
      }}
      hostTree={hostTree}
    />
  );

  return { items, modals };
}
