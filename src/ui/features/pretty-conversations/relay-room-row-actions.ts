// relay-room-row-actions.ts — what a relay room's Leave and Rename… row-menu
// items do on this side: ask, call the server, then update the sidebar and
// open panes at once.

import { kitAlert, kitConfirm, kitPrompt } from "@/components/kit";
import { leaveRelayRoom, renameRelayRoom } from "@/api/relay-room-actions-api";
import { removeRelayRoomSession, setRelayRoomTitle } from "@/state/conversation-store";

/** Matches the server's cap on a room name. */
export const RELAY_ROOM_NAME_MAX_LENGTH = 255;

// ─── Leaving closes every open pane of the room ─────────────────────────────
//
// Fired once the server confirms the leave; AppShell closes every tab of the
// room in this window.

export const RELAY_ROOM_LEFT_EVENT = "skynet:relay-room-left";

export type RelayRoomLeftDetail = { roomId: string };

function announceRelayRoomLeft(roomId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RelayRoomLeftDetail>(RELAY_ROOM_LEFT_EVENT, { detail: { roomId } }),
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function confirmAndLeaveRelayRoom(args: { roomId: string; title: string }): void {
  const { roomId, title } = args;
  void (async () => {
    const ok = await kitConfirm({
      title: `Leave "${title}"?`,
      body: "It leaves your sidebar. Only someone still in the room can bring you back.",
      confirmLabel: "Leave",
      destructive: true,
    });
    if (!ok) return;
    try {
      await leaveRelayRoom(roomId);
    } catch (err) {
      console.warn({ operation: "relay_room_leave_failed", roomId, errMessage: errMessage(err) });
      void kitAlert({ title: "Couldn't leave the room", body: errMessage(err) });
      return;
    }
    console.info({ operation: "relay_room_left", roomId });
    removeRelayRoomSession(roomId);
    announceRelayRoomLeft(roomId);
  })();
}

export function promptAndRenameRelayRoom(args: { roomId: string; currentTitle: string }): void {
  const { roomId, currentTitle } = args;
  void (async () => {
    const raw = await kitPrompt({
      title: "Rename room",
      defaultValue: currentTitle,
      confirmLabel: "Rename",
      validate: (v) =>
        v.trim().length === 0
          ? "Enter a name."
          : v.trim().length > RELAY_ROOM_NAME_MAX_LENGTH
            ? `Name must be ${RELAY_ROOM_NAME_MAX_LENGTH} characters or fewer.`
            : null,
    });
    if (raw === null) return;
    const next = raw.trim();
    if (next.length === 0 || next === currentTitle || next.length > RELAY_ROOM_NAME_MAX_LENGTH) return;
    try {
      const result = await renameRelayRoom(roomId, next);
      if (result === "not_allowed") {
        console.info({ operation: "relay_room_rename_not_allowed", roomId });
        void kitAlert({
          title: "You can't rename this room",
          body: "Someone else in the room decides who can change its name.",
        });
        return;
      }
    } catch (err) {
      console.warn({ operation: "relay_room_rename_failed", roomId, errMessage: errMessage(err) });
      void kitAlert({ title: "Couldn't rename the room", body: errMessage(err) });
      return;
    }
    console.info({ operation: "relay_room_renamed", roomId });
    setRelayRoomTitle(roomId, next);
  })();
}
