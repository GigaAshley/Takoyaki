/**
 * useRelayRoomUploads — files staged in a relay room's composer.
 *
 * The staging half only: the chips above the text, and the room's upload
 * limit check. A file over the limit is caught the moment it's attached —
 * it stays staged as an error chip naming the limit, and the composer holds
 * Send until it's removed. Sending is the relay adapter's (sendFiles).
 *
 * Same shapes as usePrettyViewUploads' staging so the composer's chip strip
 * and the drop / paste / Save-from-file-window paths work unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRelayRoomUploadLimit } from "@/api/relay-room-files-api";
import type { StagedAttachment } from "./use-pretty-view-uploads";

/** Upload limits per room, for this page load. */
const limitCache = new Map<string, Promise<number | null>>();

function loadLimit(roomId: string): Promise<number | null> {
  let p = limitCache.get(roomId);
  if (!p) {
    p = getRelayRoomUploadLimit(roomId).catch((err: unknown) => {
      limitCache.delete(roomId);
      console.warn({
        operation: "relay_room_upload_limit_failed",
        roomId,
        errMessage: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    limitCache.set(roomId, p);
  }
  return p;
}

/** Test seam. */
export function __resetRelayRoomUploadLimitsForTest(): void {
  limitCache.clear();
}

export function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function tooBigNote(limit: number): string {
  return `Too big to send to this room — the limit is ${formatLimit(limit)}`;
}

function newTempId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Files out of a picker / paste list, or a drop (folders refused). */
function filesFrom(items: File[] | DataTransferItemList | FileList): File[] {
  if (Array.isArray(items)) return items;
  if (typeof FileList !== "undefined" && items instanceof FileList) return Array.from(items);
  const out: File[] = [];
  const list = items as DataTransferItemList;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (it.kind !== "file") continue;
    const entry = typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

export interface UseRelayRoomUploadsReturn {
  stagedAttachments: StagedAttachment[];
  stageAttachments: (target: string, items: File[] | DataTransferItemList | FileList) => void;
  removeAttachment: (tempId: string) => void;
  /** Drop every staged file (after a send). */
  clearStaged: () => void;
}

export function useRelayRoomUploads(roomId: string | null): UseRelayRoomUploadsReturn {
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [limit, setLimit] = useState<number | null>(null);
  const roomRef = useRef(roomId);
  roomRef.current = roomId;

  useEffect(() => {
    setStaged([]);
    setLimit(null);
    if (roomId === null) return;
    let live = true;
    void loadLimit(roomId).then((v) => {
      if (live && roomRef.current === roomId) setLimit(v);
    });
    return () => {
      live = false;
    };
  }, [roomId]);

  // Re-judge staged files whenever the limit becomes known.
  const judged = useMemo<StagedAttachment[]>(
    () =>
      staged.map((a) =>
        limit !== null && a.file.size > limit
          ? { ...a, status: "error", error: tooBigNote(limit) }
          : a,
      ),
    [staged, limit],
  );

  const stageAttachments = useCallback(
    (_target: string, items: File[] | DataTransferItemList | FileList) => {
      if (roomRef.current === null) return;
      const files = filesFrom(items);
      if (files.length === 0) return;
      setStaged((prev) => [
        ...prev,
        ...files.map((file) => ({
          tempId: newTempId(),
          file,
          status: "staged" as const,
          bytesUploaded: 0,
          error: null,
        })),
      ]);
    },
    [],
  );

  const removeAttachment = useCallback((tempId: string) => {
    setStaged((prev) => prev.filter((a) => a.tempId !== tempId));
  }, []);

  const clearStaged = useCallback(() => setStaged([]), []);

  return { stagedAttachments: judged, stageAttachments, removeAttachment, clearStaged };
}
