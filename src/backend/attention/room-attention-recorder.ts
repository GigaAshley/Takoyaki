/**
 * room-attention-recorder.ts — turns posts in a user's relay rooms into the
 * sidebar's unread dot and red envelope, and tells their open tabs.
 *
 * The push-trigger loop calls these per Matrix event in a room that shows in
 * the user's sidebar: recordRoomPost for someone else's post, recordOwnRoomPost
 * for the user's own (from any app — everything up to it is then seen), and
 * publishRoomNotification when a person's post should also notify.
 */
import { systemLogger } from "../utils/logger.js";
import { getRegistry } from "../fleet-status/registry-holder.js";
import { FRAME_SCHEMA_VERSION } from "../fleet-status/wire-protocol.js";
import { userCanUseNotifications } from "../notifications/notifications-access.js";
import { getRoomAttentionStore, type RoomAttentionEntry } from "./room-attention-store.js";

/** Push a user's current marks for one room to all their tabs. */
export function publishRoomAttention(userId: string, entry: RoomAttentionEntry): void {
  const registry = getRegistry();
  if (!registry) {
    systemLogger.warn("attention room-state: registry not ready, tabs not told", {
      operation: "attention_room_state_no_registry",
      userId,
      roomId: entry.roomId,
    });
    return;
  }
  registry.publishToUser(userId, {
    schemaVersion: FRAME_SCHEMA_VERSION,
    type: "relay-room-attention-changed",
    roomId: entry.roomId,
    lastMessageAt: entry.lastMessageAt,
    seenMessageAt: entry.seenMessageAt,
    lastDmAt: entry.lastDmAt,
    seenDmAt: entry.seenDmAt,
  });
}

/** Someone else posted in `roomId` at `at`; `fromPerson` — a person, not an agent. */
export function recordRoomPost(userId: string, roomId: string, at: number, fromPerson: boolean): void {
  const entry = getRoomAttentionStore().recordMessage(userId, roomId, at, fromPerson);
  systemLogger.info("attention room post recorded", {
    operation: "attention_room_post",
    userId,
    roomId,
    at,
    fromPerson,
    advanced: entry !== null,
  });
  if (entry) publishRoomAttention(userId, entry);
}

/** The user posted in `roomId` at `at` (from any app): everything before is seen. */
export function recordOwnRoomPost(userId: string, roomId: string, at: number): void {
  const entry = getRoomAttentionStore().markSeenByOwnPost(userId, roomId, at);
  if (!entry) return;
  systemLogger.info("attention room seen by own post", {
    operation: "attention_room_seen_own_post",
    userId,
    roomId,
    at,
  });
  publishRoomAttention(userId, entry);
}

export interface RoomNotification {
  /** The post's Matrix event id — the same on every tab. */
  notificationId: string;
  roomId: string;
  title: string;
  body: string;
}

/**
 * Tell every open tab of `userId` that a person just posted in one of their
 * rooms, with the words to show, so a tab can raise a browser notification.
 * Same access gate as Telegram.
 */
export function publishRoomNotification(userId: string, n: RoomNotification): void {
  if (!userCanUseNotifications(userId)) return;
  const registry = getRegistry();
  if (!registry) {
    systemLogger.warn("attention room-notified: registry not ready, tabs not told", {
      operation: "attention_room_notified_no_registry",
      userId,
      roomId: n.roomId,
    });
    return;
  }
  registry.publishToUser(userId, {
    schemaVersion: FRAME_SCHEMA_VERSION,
    type: "relay-room-notified",
    notificationId: n.notificationId,
    roomId: n.roomId,
    title: n.title,
    body: n.body,
  });
  systemLogger.info("attention room-notified published", {
    operation: "attention_room_notified",
    userId,
    roomId: n.roomId,
    notificationId: n.notificationId,
  });
}
