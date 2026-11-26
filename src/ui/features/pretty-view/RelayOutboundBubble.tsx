import { useState, type MouseEvent } from "react";
import type { RelayOutboundEvent, RelaySendResultEvent } from "@/api/claude-session-api";
import type { Identity } from "@/api/identities-api";
import { useIdentities } from "@/state/identities-store";
import { speakVoiceCandidates } from "./voice-candidates";
import { useSpeakPlayback } from "./useSpeakPlayback";
import { addressingFor, mxidLocalpart, partyForAddressee, previewLine, type RelayParty } from "./relay-addressing";
import { useViewingUserMxid } from "@/state/viewing-user-store";
import { useRelayRoomMembers } from "./relay-room-members";
import { RelayChatBubble, RelayDmCard, RelayToYouBubble } from "./RelayBubbleParts";
import { RoomFileChip } from "./RoomFileChip";
import { buildRoomFileUrl } from "./room-file";
import { linkifyText } from "./linkify-text";

// RelayOutboundBubble — a relay message this pane's agent sent. Harness view
// renders a folded RelayDmCard ("Aster → Tina [DM]"). The recipient comes
// from the room's members when the send named a room; a relay-mcp send to a
// person carries `to`, which names them directly ("Aster → You"), and once its
// result arrives the result's room gives the exact members. A failed relay-mcp
// send reads "not sent" (never "notified"). Otherwise the card reads "Aster
// sent a DM".
//
// A relay-mcp file send shows the posted file itself (pictures inline) once
// its result names the post, the same chip a relay room shows; until then,
// when it failed, or when the viewer can't open it (not in the room), its
// "📎 name" text.
//
// The raw send command is never shown. When the message text couldn't be
// extracted from the command, the card says so in plain words.
//
// Security: body renders as a React text child, never
// dangerouslySetInnerHTML.

export type RelayOutboundBubbleProps = Pick<RelayOutboundEvent, "room" | "body" | "to" | "file"> & {
  /** ms-epoch timestamp; shown as a hover title. */
  ts?: number;
  /** Relay-source view: plain chat bubble, always open. */
  alwaysExpanded?: boolean;
  /** hostId from PrettyViewProps — scopes the member lookup. */
  hostId?: number;
  /** The pane's own agent — the sender. */
  selfIdentity?: Identity | null;
  /** The viewing user's fallback voice — last candidate before the provider default. */
  fallbackVoice?: string | null;
  /** relay-mcp sends: the call's outcome, once its tool_result has arrived. */
  result?: RelaySendResultEvent | null;
  /** Opens the file window for a sent file (same contract as other file chips). */
  onOpenEditor?: (args: { messageEventId: string; url: string; filename: string }) => void;
  /** Encoded tab spec of this conversation, for dragging a sent file into a pane. */
  fileDragOrigin?: string | null;
};

export function RelayOutboundBubble({
  room,
  body,
  to = null,
  ts,
  alwaysExpanded = false,
  hostId,
  selfIdentity = null,
  fallbackVoice = null,
  result = null,
  file = null,
  onOpenEditor,
  fileDragOrigin = null,
}: RelayOutboundBubbleProps) {
  const { byKey } = useIdentities();
  const viewerMxid = useViewingUserMxid();
  const [open, setOpen] = useState(alwaysExpanded);
  const members = useRelayRoomMembers(
    alwaysExpanded ? null : room ?? (result?.ok ? result.roomId : null),
    hostId,
  );

  // Relay-source view has no pane agent — an outbound there is the viewing
  // user's own send echoed back from the room.
  const sender: RelayParty = selfIdentity
    ? {
        name: selfIdentity.displayName,
        hue: selfIdentity.colorHue,
        you: false,
        avatarUrl: selfIdentity.avatarUrl || null,
      }
    : alwaysExpanded
      ? { name: "You", hue: null, you: true }
      : { name: "This agent", hue: null, you: false };
  const addressing = addressingFor(
    selfIdentity?.identityKey.toLowerCase() ?? null,
    members,
    byKey,
    to ? partyForAddressee(to, byKey, viewerMxid) : null,
  );

  const { speakState, onSpeakClick } = useSpeakPlayback({
    ownerName: "relay-speak-bubble",
    logPrefix: "relay:",
    voices: speakVoiceCandidates(selfIdentity, fallbackVoice),
    getText: () => body ?? "",
  });
  const speak =
    body !== null
      ? { speakState, onClick: (e: MouseEvent) => { void onSpeakClick(e); } }
      : null;

  const posted =
    file && result?.ok && result.roomId && result.matrixEventId
      ? { roomId: result.roomId, eventId: result.matrixEventId }
      : null;
  const text =
    body !== null ? (
      linkifyText(body)
    ) : (
      <div className="text-xs italic text-[color:var(--k-t3)] whitespace-normal">
        {sender.name} sent a message here, but its text couldn't be shown.
      </div>
    );
  const content = posted && file ? (
    <RoomFileChip
      file={{
        roomId: posted.roomId,
        eventId: posted.eventId,
        name: file.name,
        size: null,
        mimetype: null,
        url: buildRoomFileUrl(posted.roomId, posted.eventId, file.name),
        ...(file.caption ? { caption: file.caption } : {}),
      }}
      onOpenEditor={onOpenEditor}
      dragOrigin={fileDragOrigin}
      fallback={text}
    />
  ) : (
    text
  );

  if (alwaysExpanded) {
    return (
      <RelayChatBubble
        testIdPrefix="relay-outbound"
        sender={sender}
        ts={ts}
        speak={speak}
        // Your own echo is "You" on screen; a quote names you as the room knows you.
        quoteName={sender.you && viewerMxid ? mxidLocalpart(viewerMxid) : undefined}
      >
        {content}
      </RelayChatBubble>
    );
  }

  const failed = result && !result.ok ? result.error ?? "the send failed" : null;
  // A message to the user is read in place — never folded behind a header.
  if (addressing.kind === "dm" && addressing.to.you) {
    return (
      <RelayToYouBubble testIdPrefix="relay-outbound" sender={sender} ts={ts} speak={speak} failed={failed}>
        {content}
      </RelayToYouBubble>
    );
  }

  return (
    <RelayDmCard
      testIdPrefix="relay-outbound"
      sender={sender}
      addressing={addressing}
      preview={body !== null ? previewLine(body) : ""}
      ts={ts}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      speak={speak}
      failed={failed}
    >
      {content}
    </RelayDmCard>
  );
}
