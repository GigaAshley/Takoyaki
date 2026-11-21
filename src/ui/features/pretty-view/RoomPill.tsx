// ─── RoomPill ────────────────────────────────────────────────────────────────
//
// The top-center handle of an open relay room, the room's counterpart to a
// conversation's task pill:
//   - the room's faces (stacked, as on its sidebar row) + the room's name
//   - hover → the full name, then everyone else in the room
//   - ⋯ / right-click / press-and-hold → the room's menu
//   - drag → the pane handle (drop lane, split rearrange, other windows,
//     filing into sidebar sections) — desktop only
//   - a tap does nothing (a room has no window to open)
// No memory pie and no round buttons — those belong to agents. The member
// badges sit beside it at the top right (MultiBadgeAnchor).

import { forwardRef, type DragEvent as ReactDragEvent } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { KitScopeContext, type KitScopeValue } from "@/components/kit/scope";
import { writeBadgeDragData } from "@/shell/badge-drag";
import {
  RowKebabMenu,
  useRowKebabContextMenu,
  type RowKebabMenuItem,
} from "@/features/pretty-conversations/RowKebabMenu";
import { isCoarsePointer } from "@/features/pretty-conversations/row-touch-gestures";
import { RelayRoomFaces } from "@/features/pretty-conversations/RelayRoomFaces";
import type { RelayRoomFace } from "@/api/sessions-api";

const PILL_KIT_SCOPE: KitScopeValue = { hue: 220 };

/** Room kept clear on each side (the phone's back button, the pane margin). */
export const ROOM_PILL_SIDE_RESERVE_PX = 64;

export interface RoomPillProps {
  roomId: string;
  /** The room's name; null while unknown (the pill says "Relay room"). */
  title: string | null;
  faces: readonly RelayRoomFace[];
  othersCount: number;
  /** Names of everyone else in the room, for the hover. */
  memberNames: readonly string[];
  /** Pane tab id; absent → not a drag source. */
  tabId?: string;
  menuItems: RowKebabMenuItem[];
}

export const RoomPill = forwardRef<HTMLDivElement, RoomPillProps>(function RoomPill(
  { roomId, title, faces, othersCount, memberNames, tabId, menuItems },
  ref,
) {
  const isMobile = useIsMobile();
  const isDragSource = !!tabId && !isMobile && !isCoarsePointer();
  const contextMenu = useRowKebabContextMenu(menuItems);
  const name = title && title.length > 0 ? title : "Relay room";
  const tooltip = [name, memberNames.join(", ")].filter(Boolean).join(" · ");

  const onDragStart = isDragSource
    ? (e: ReactDragEvent<HTMLElement>) => {
        const dragId = writeBadgeDragData(e.dataTransfer, {
          tabId: tabId!,
          identityKey: null,
          hostId: null,
          descriptor: {
            tabType: "terminal",
            sessionKind: "relay-room",
            relayRoomId: roomId,
            relayRoomTitle: title,
          },
        });
        console.info(`[room-pill-drag] tabId=${tabId} dragId=${dragId}`);
      }
    : undefined;

  return (
    <div
      ref={ref}
      data-testid="pv-room-pill-anchor"
      className="absolute top-3 inset-x-0 mx-auto w-fit z-[101] flex"
      style={{ maxWidth: `calc(100% - ${ROOM_PILL_SIDE_RESERVE_PX * 2}px)` }}
    >
      <div
        data-testid="pv-room-pill"
        title={tooltip}
        onContextMenu={contextMenu.onContextMenu}
        {...contextMenu.holdProps}
        draggable={isDragSource}
        onDragStart={onDragStart}
        className="pv-float relative flex flex-row items-center gap-0.5 h-10 min-w-0 max-w-full rounded-full pl-1 pr-1 select-none [-webkit-touch-callout:none]"
      >
        <div className="flex flex-row items-center gap-[9px] h-8 min-w-0 pl-0.5 pr-2">
          {faces.length > 0 && (
            <span
              data-testid="pv-room-pill-faces"
              className="relative shrink-0 inline-block"
              style={{ width: 26, height: 26, fontSize: 11, ["--pv-sb-bg" as string]: "rgb(22, 24, 30)" }}
              aria-hidden="true"
            >
              <RelayRoomFaces faces={faces} othersCount={othersCount} />
            </span>
          )}
          <span
            data-testid="pv-room-pill-label"
            className="truncate min-w-0 text-[color:var(--k-t1)]"
            style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.005em" }}
          >
            {name}
          </span>
        </div>
        {menuItems.length > 0 && (
          // Its own (cancelled) drag source so a press-and-move starting on
          // the ⋯ doesn't drag the pane.
          <span
            className="shrink-0 inline-flex"
            draggable
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <KitScopeContext.Provider value={PILL_KIT_SCOPE}>
              <RowKebabMenu
                items={menuItems}
                ariaLabel="Room menu"
                testId="pv-room-pill-kebab-trigger"
                triggerClassName="rounded-full"
              />
            </KitScopeContext.Provider>
          </span>
        )}
      </div>
      {contextMenu.menu}
    </div>
  );
});
