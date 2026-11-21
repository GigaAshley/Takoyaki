// RoomPersonBadge — a person's badge in an open relay room's top row. Same
// pill as an agent's badge (round picture + name), but a person's own
// picture (or initial) on a plain neutral ring, and no memory pie. Also the
// fallback for a member the app can't draw as an agent, so nobody in the room
// is ever left without a badge.

import type { CSSProperties, DragEvent as ReactDragEvent } from "react";
import { AvatarImage } from "@/components/avatar-image";
import { useIsMobile } from "@/hooks/use-mobile";
import { writeBadgeDragData, type BadgeDragSource } from "@/shell/badge-drag";
import { isCoarsePointer } from "@/features/pretty-conversations/row-touch-gestures";

const AVATAR_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: 30,
  height: 30,
  borderRadius: "50%",
  boxShadow: "0 0 0 1.5px rgba(220, 225, 245, 0.28)",
};

/** A person's uploaded picture, as the sidebar's room faces load it. */
export function personAvatarUrl(userId: string | null | undefined, avatarPath: string | null | undefined): string | null {
  if (!userId || !avatarPath) return null;
  return `/users/${encodeURIComponent(userId)}/avatar?f=${encodeURIComponent(avatarPath)}`;
}

export function RoomPersonBadge({
  name,
  avatarUrl,
  tabId,
  dragKey,
  dragDescriptor,
}: {
  name: string;
  avatarUrl: string | null;
  /** The room tab — like agent badges, dragging the badge drags the room. */
  tabId?: string;
  /** The member's mxid localpart, carried in the drag for logs only. */
  dragKey?: string;
  dragDescriptor?: BadgeDragSource["descriptor"];
}) {
  const isMobile = useIsMobile();
  const isDragSource = !!tabId && !isMobile && !isCoarsePointer();
  const onDragStart = isDragSource
    ? (e: ReactDragEvent<HTMLElement>) => {
        const dragId = writeBadgeDragData(e.dataTransfer, {
          tabId: tabId!,
          identityKey: dragKey ?? null,
          hostId: null,
          descriptor: dragDescriptor ?? null,
        });
        console.info(`[badge-drag] tabId=${tabId} dragId=${dragId} person=true hasDescriptor=${dragDescriptor != null}`);
      }
    : undefined;
  return (
    <div
      draggable={isDragSource}
      onDragStart={onDragStart}
      data-testid="relay-room-person-badge"
      className="pv-identity-badge pv-float flex flex-row items-center gap-[9px] h-10 rounded-full select-none [-webkit-touch-callout:none]"
      style={{ overflow: "hidden", padding: "4px 14px 4px 4px" }}
      aria-hidden="true"
    >
      <AvatarImage
        src={avatarUrl}
        name={name}
        className="object-cover shrink-0"
        style={AVATAR_STYLE}
        initialClassName="shrink-0 inline-flex items-center justify-center font-semibold"
        initialStyle={{ ...AVATAR_STYLE, fontSize: 13, color: "#f0ebe0", background: "rgba(120, 124, 140, 0.9)" }}
      />
      <span
        className="pv-badge-name font-semibold truncate leading-tight text-[color:var(--k-t1)]"
        style={{ fontSize: 13.5, position: "relative", zIndex: 1 }}
      >
        {name}
      </span>
    </div>
  );
}
