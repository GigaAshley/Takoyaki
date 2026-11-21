// relay-room-actions-api.ts — Leave and Rename… for a relay room, as the
// signed-in user (backend: src/backend/database/routes/relay-room-actions.ts).

import axios from "axios";
import { authApi } from "@/main-axios";

/** Leave the room for real. Throws on failure. */
export async function leaveRelayRoom(roomId: string): Promise<void> {
  await authApi.post(`/relay-room/${encodeURIComponent(roomId)}/leave`, {});
}

export type RenameRelayRoomResult = "renamed" | "not_allowed";

/**
 * Set the room's name for every member. "not_allowed" when the user can't
 * be given the right to rename (another person controls the room). Throws
 * on any other failure.
 */
export async function renameRelayRoom(
  roomId: string,
  name: string,
): Promise<RenameRelayRoomResult> {
  try {
    await authApi.post(`/relay-room/${encodeURIComponent(roomId)}/rename`, { name });
    return "renamed";
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      const code = (err.response.data as { error?: unknown } | undefined)?.error;
      if (code === "not_allowed") return "not_allowed";
    }
    throw err;
  }
}
