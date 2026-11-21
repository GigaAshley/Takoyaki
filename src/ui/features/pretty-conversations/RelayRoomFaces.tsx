// RelayRoomFaces — the picture spot of a relay room's sidebar row: the faces
// of up to two other members (in join order) overlapping, with "+N" when
// there are more. One other member shows as a single face filling the spot,
// like any one-to-one conversation.
//
// Agents show their own picture (from the identities store); people show
// their uploaded picture, or their initial.

import type { CSSProperties } from "react";
import type { RelayRoomFace } from "@/api/sessions-api";
import { AvatarImage } from "@/components/avatar-image";
import { useIdentities } from "@/state/identities-store";
import { resolveMxidToIdentity } from "@/features/pretty-view/relay-mxid-resolve";

const FILL: CSSProperties = { width: "100%", height: "100%", objectFit: "cover", borderRadius: "999px" };

function humanAvatarUrl(face: RelayRoomFace): string | null {
  if (!face.userId || !face.avatarPath) return null;
  return `/users/${encodeURIComponent(face.userId)}/avatar?f=${encodeURIComponent(face.avatarPath)}`;
}

function Face({ face }: { face: RelayRoomFace }) {
  const { byKey } = useIdentities();
  if (face.kind === "agent") {
    const { identity } = resolveMxidToIdentity(face.mxid, byKey);
    return (
      <AvatarImage
        src={identity?.avatarUrl}
        name={identity?.displayName ?? face.name}
        className="pv-avatar-img"
        style={FILL}
        initialClassName="pv-avatar-initial"
      />
    );
  }
  return (
    <AvatarImage
      src={humanAvatarUrl(face)}
      name={face.name}
      className="pv-avatar-img"
      style={FILL}
      initialClassName="pv-avatar-initial"
    />
  );
}

export function RelayRoomFaces({
  faces,
  othersCount,
}: {
  faces: readonly RelayRoomFace[];
  othersCount: number;
}) {
  const shown = faces.slice(0, 2);
  const more = Math.max(0, othersCount - shown.length);
  if (shown.length === 1) {
    return (
      <span className="pv-room-face pv-room-face--solo" data-testid="pv-room-face" data-mxid={shown[0].mxid}>
        <Face face={shown[0]} />
      </span>
    );
  }
  return (
    <>
      {shown.map((f, i) => (
        <span
          key={f.mxid}
          className={i === 0 ? "pv-room-face pv-room-face--back" : "pv-room-face pv-room-face--front"}
          data-testid="pv-room-face"
          data-mxid={f.mxid}
        >
          <Face face={f} />
        </span>
      ))}
      {more > 0 && (
        <span className="pv-room-more" data-testid="pv-room-more" aria-label={`${more} more`}>
          +{more}
        </span>
      )}
    </>
  );
}
