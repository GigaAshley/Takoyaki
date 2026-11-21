// RoomFileChip — a file or picture posted in a relay room, shown the way
// every file in the app is: the same file chip (pictures inline), opening
// the file window, draggable into a file pane. A post whose file can't be
// opened — encrypted, or gone from the chat server — shows as a quiet chip
// with its name and a note instead of vanishing.

import { useEffect, useState } from "react";
import { FileWarning } from "lucide-react";
import type { RoomFileRef } from "@/api/claude-session-api";
import { getRelayRoomFileStatus } from "@/api/relay-room-files-api";
import { FileChip } from "./FileChip";

/** One status check per posted file per page load. */
const statusCache = new Map<string, Promise<string>>();

function checkStatus(file: RoomFileRef): Promise<string> {
  const key = `${file.roomId}\n${file.eventId}`;
  let p = statusCache.get(key);
  if (!p) {
    p = getRelayRoomFileStatus(file.roomId, file.eventId);
    statusCache.set(key, p);
  }
  return p;
}

/** Test seam: forget every status check. */
export function __resetRoomFileStatusCacheForTest(): void {
  statusCache.clear();
}

function noteFor(reason: string): string {
  return reason === "room_file_encrypted" || reason === "encrypted"
    ? "Encrypted — can't be opened here"
    : "No longer available — can't be opened";
}

export function UnavailableFileChip({ name, reason }: { name: string; reason: string }) {
  const note = noteFor(reason);
  return (
    <div
      data-testid="room-file-unavailable"
      data-reason={reason}
      title={`${name} — ${note}`}
      className="inline-flex items-center gap-2 max-w-full px-2.5 py-1.5 rounded-md text-xs border border-white/10 bg-white/[0.04] text-[#e8e4d8]"
    >
      <FileWarning className="size-4 shrink-0 opacity-60" aria-hidden />
      <span className="truncate">{name}</span>
      <span className="shrink-0 opacity-60">{note}</span>
    </div>
  );
}

export interface RoomFileChipProps {
  file: RoomFileRef;
  /** Opens the file window (same contract as other file chips). */
  onOpenEditor?: (args: { messageEventId: string; url: string; filename: string }) => void;
  /** Encoded tab spec of the room's conversation, for drags into a pane. */
  dragOrigin?: string | null;
}

export function RoomFileChip({ file, onOpenEditor, dragOrigin }: RoomFileChipProps) {
  const [gone, setGone] = useState<string | null>(null);

  useEffect(() => {
    if (file.url === null) return;
    let live = true;
    void checkStatus(file).then((status) => {
      if (!live) return;
      if (status === "not_found" || status === "room_file_encrypted" || status === "not_a_file") {
        console.info({
          operation: "relay_room_file_unavailable",
          roomId: file.roomId,
          eventId: file.eventId,
          reason: status,
        });
        setGone(status);
      }
    });
    return () => {
      live = false;
    };
  }, [file.url, file.roomId, file.eventId]);

  if (file.url === null || gone !== null) {
    return <UnavailableFileChip name={file.name} reason={gone ?? file.unavailable ?? "missing"} />;
  }
  const url = file.url;
  return (
    <FileChip
      url={url}
      filename={file.name}
      {...(file.size !== null ? { size: file.size } : {})}
      dragOrigin={dragOrigin}
      onOpen={() =>
        onOpenEditor?.({ messageEventId: file.eventId, url, filename: file.name })
      }
    />
  );
}
