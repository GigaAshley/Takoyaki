import { authApi, handleApiError } from "@/main-axios";
import {
  inMachineOrder,
  sendMachineChange,
  whenMachineDone,
  type MachineChangeAnswer,
} from "@/api/machine-changes-api";
import { settleIdentityProjectIntent, startIdentityProjectIntent } from "@/state/identities-store";

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
 * in order with the machine's other changes. The agent shows in its new place at once and
 * stays there while the machine has the move waiting its turn. Throws MachineChangeError
 * with the machine's reason when refused (the project is gone, the agent is being archived)
 * — the row is back where it was by then. A refusal after this stopped asking puts the row
 * back too, and the machine's reason shows on it (machine-changes-store).
 */
export async function setSessionProject(
  hostId: number,
  identityKey: string,
  projectSlug: string | null,
): Promise<{ ok: true }> {
  const seq = startIdentityProjectIntent(identityKey, hostId, projectSlug);
  let answer: MachineChangeAnswer<unknown>;
  try {
    answer = await inMachineOrder(hostId, () =>
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
  } catch (err) {
    settleIdentityProjectIntent(identityKey, hostId, seq, false);
    throw err;
  }
  if (answer.done) {
    settleIdentityProjectIntent(identityKey, hostId, seq, true);
  } else {
    void whenMachineDone(hostId, answer).then((ended) => {
      console.info({ operation: "agent_move_settled_later", hostId, identityKey, project: projectSlug, ended });
      settleIdentityProjectIntent(identityKey, hostId, seq, ended === "done");
    });
  }
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
