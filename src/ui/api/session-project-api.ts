import { authApi, handleApiError } from "@/main-axios";
import { inMachineOrder, sendMachineChange } from "@/api/machine-changes-api";

// ─── Phase 117 Plan 117-06 (D-05 / D-05a) — session-project-api ─────────────
//
// Frontend wrappers for the session-project-write (identity route) and the
// relay-room-project-tag (Matrix route) endpoints landed by Plan 117-05.
// Both accept null as the third argument to CLEAR the project membership
// (writer strips the frontmatter field / m.tag entry respectively per
// D-05a's read-modify-write discipline).
//
// Endpoints:
//   POST /identities/:key/project           body { hostId, project, requestId }
//                                             → the machine's answer (front door)
//   POST /relay-rooms/:roomId/project       body { userMxid, project }
//                                             → { ok: true }
//
// Byte-shape mirror of identity-archive-api.ts. authApi + handleApiError,
// one try/catch per wrapper, no error swallowing.

/**
 * Move an agent into a project (or out of one, null): a change at the machine's front door,
 * in order with the machine's other changes. Throws MachineChangeError with the machine's
 * reason when refused (the project is gone, the agent is being archived).
 */
export async function setSessionProject(
  hostId: number,
  identityKey: string,
  projectSlug: string | null,
): Promise<{ ok: true }> {
  await inMachineOrder(hostId, () =>
    sendMachineChange(
      hostId,
      {
        method: "post",
        url: `/identities/${encodeURIComponent(identityKey)}/project`,
        body: { hostId, project: projectSlug },
      },
      "move to project",
      { followUp: "resend" },
    ),
  );
  return { ok: true };
}

export async function setRelayRoomProject(
  roomId: string,
  userMxid: string,
  projectSlug: string | null,
): Promise<{ ok: true }> {
  try {
    const url = `/relay-rooms/${encodeURIComponent(roomId)}/project`;
    const response = await authApi.post(url, {
      userMxid,
      project: projectSlug,
    });
    return response.data as { ok: true };
  } catch (error) {
    handleApiError(error, "set relay room project");
  }
}

// Pin (the chat server's favourite tag) or unpin a relay room for the user.
// Pinning takes the room out of its project in the same write.
export async function setRelayRoomPinned(
  roomId: string,
  userMxid: string,
  pinned: boolean,
): Promise<{ ok: true }> {
  try {
    const url = `/relay-rooms/${encodeURIComponent(roomId)}/pin`;
    const response = await authApi.post(url, { userMxid, pinned });
    return response.data as { ok: true };
  } catch (error) {
    handleApiError(error, "set relay room pin");
  }
}
