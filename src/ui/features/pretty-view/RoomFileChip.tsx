// RoomFileChip — a file or picture posted in a relay room, shown the way
// every file in the app is: the same file chip (pictures inline), opening
// the file window, draggable into a file pane. A post whose file can't be
// opened — encrypted, or gone from the chat server — shows as a quiet chip
// with its name and a note instead of vanishing. A caption written inside
// the post (another client's picture-with-text) shows under the chip.

import { useEffect, useState, type ReactNode } from "react";
import { FileWarning } from "lucide-react";
import type { RoomFileRef } from "@/api/claude-session-api";
import { getRelayRoomFileStatus } from "@/api/relay-room-files-api";
import { FileChip } from "./FileChip";

/** One status check per posted file per page load, a few at a time. */
const statusCache = new Map<string, Promise<string>>();
const MAX_CHECKS_AT_ONCE = 3;
let checksRunning = 0;
const checkQueue: Array<() => void> = [];

function limited<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const start = () => {
      checksRunning++;
      void run()
        .then(resolve)
        .finally(() => {
          checksRunning--;
          checkQueue.shift()?.();
        });
    };
    if (checksRunning < MAX_CHECKS_AT_ONCE) start();
    else checkQueue.push(start);
  });
}

function checkStatus(file: RoomFileRef): Promise<string> {
  const key = `${file.roomId}\n${file.eventId}`;
  let p = statusCache.get(key);
  if (!p) {
    p = limited(() => getRelayRoomFileStatus(file.roomId, file.eventId));
    statusCache.set(key, p);
  }
  return p;
}

/** Test seam: forget every status check. */
export function __resetRoomFileStatusCacheForTest(): void {
  statusCache.clear();
  checkQueue.length = 0;
  checksRunning = 0;
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
  /**
   * Shown instead of the "can't be opened" chip when the file can't be opened
   * — for a file sent from a conversation whose viewer isn't in the room.
   */
  fallback?: ReactNode;
}

export function RoomFileChip({ file, onOpenEditor, dragOrigin, fallback }: RoomFileChipProps) {
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

  const caption = file.caption ? (
    <div data-testid="room-file-caption" className="mt-1.5 whitespace-pre-wrap">
      {file.caption}
    </div>
  ) : null;
  if (file.url === null || gone !== null) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <>
        <UnavailableFileChip name={file.name} reason={gone ?? file.unavailable ?? "missing"} />
        {caption}
      </>
    );
  }
  const url = file.url;
  return (
    <>
      <FileChip
        url={url}
        filename={file.name}
        {...(file.size !== null ? { size: file.size } : {})}
        dragOrigin={dragOrigin}
        onOpen={() =>
          onOpenEditor?.({ messageEventId: file.eventId, url, filename: file.name })
        }
      />
      {caption}
    </>
  );
}
