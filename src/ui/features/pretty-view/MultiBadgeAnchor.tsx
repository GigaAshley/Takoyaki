// Phase 93 Slice 2 Task 2 — MultiBadgeAnchor.
//
// Multi-badge extension of PrettyView's upper-right badge anchor. Mounted
// ONLY when `source.kind === "relay"` (PrettyView Task 3 gates the mount).
// Renders humans-first-alphabetical then agents-alphabetical with the
// viewing user excluded from humans (D-03 self-exclusion).
//
// ## Layout (D-01)
//
// Root container is `absolute top-4 right-5 z-[101] flex flex-row-reverse
// items-start gap-1` — position-parity with the harness single-badge anchor
// at PrettyView.tsx:3349-3366 (harness has no inner gap because it renders
// a single badge). Inner gap was `gap-2` at Slice 2 ship-time; halved to
// `gap-1` in Phase 97 Plan 01 (F-4 / D-11) — the harness OUTER-instrument
// `gap-2` reads too wide when applied as an INNER gap between multi-badge
// cells; halved for tighter grouping. `flex-row-reverse` means the FIRST
// DOM child
// is RIGHTMOST visually; badges grow LEFTWARD from the harness anchor
// point. To achieve "humans-first" visual ordering (humans nearest the
// harness anchor, agents further left), agents map FIRST in JSX (rightmost
// visually) and humans map SECOND. This is Slice D's inversion; Slice D
// used a top-of-pane flex-row layout, and per RESEARCH.md Assumption A3
// we've flipped to flex-row-reverse for the leftward-growing D-01 anchor.
//
// ## Per-role rendering (D-02)
//
// - HUMAN: a person badge (RoomPersonBadge) — the same pill as an agent's,
//   with the person's own picture or initial on a neutral ring. NO meter
//   appendage. A member that can't be drawn as an agent gets one too.
// - TIGHT ROW: when the badges don't fit across the pane, every badge drops
//   its name (pictures only); hover / press-and-hold shows the name.
// - AGENT (D-02/D-08): AgentBadgeWithMeter (Task 1 port) — plain badge
//   PLUS the memory pie. It reads via Wave 0 useSessionContextPct; its
//   Compact conversation request is INTERNAL to AgentBadgeWithMeter.
//
// ## Loading vs. empty discrimination (Warning 2)
//
// When `isReady={false}` (WS still connecting), the anchor renders a
// subtle placeholder so the relay tab does NOT appear empty during the
// WS-connecting window. When `isReady={true}` with zero non-self
// participants, renders null (empty case).
//
// ## D-08 discipline
//
// This component does NOT read `source.kind`. It is only mounted when
// PrettyView (Task 3) has narrowed `source.kind === "relay"`. The
// component itself is source-oblivious — takes participants and viewing
// user as explicit props.
//
// ## D-18 discipline
//
// Badge-click in relay case is a no-op — human cells render bare
// IdentityBadge with no onClick prop; agent cells render
// AgentBadgeWithMeter whose badge is inert (the memory pie is separately
// clickable). No IdentityModal, no navigation.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { IdentityBadge } from "@/features/terminal/IdentityBadge";
import { useIdentities } from "@/state/identities-store";
import { resolveMxidToIdentity } from "@/features/pretty-view/relay-mxid-resolve";
import { AgentBadgeWithMeter } from "./AgentBadgeWithMeter";
import { RoomPersonBadge, personAvatarUrl } from "./RoomPersonBadge";
import { HOLD_MS, MOVE_SLOP, isCoarsePointer } from "@/features/pretty-conversations/row-touch-gestures";
// Phase 93 Slice 4 (D-04): types re-homed to pretty-view/sources/ as part
// of the standalone relay-source tree retirement. Byte-identical shape
// (Slice 3 Task 1 verbatim port of the wire types).
import type {
  HumanParticipant,
  AgentParticipant,
} from "./sources/relay-room-api";

export interface MultiBadgeAnchorProps {
  /** Participants — humans + agents. Both arrays may be empty. */
  participants: { humans: HumanParticipant[]; agents: AgentParticipant[] };
  /**
   * The viewing user's Matrix mxid. Drives the D-03 self-exclusion filter
   * (the viewer's own badge is not shown; the harness-anchor convention
   * "right-side-is-you" is preserved conceptually — the viewer sees others,
   * not themselves).
   */
  viewingUserMxid: string;
  /**
   * fleet-derived identityKey → hostId mapping (from
   * `buildIdentityHostsFromFleet`). Agent cells look up their host via this
   * map. Agents without a mapping render as a bare badge with a structured
   * warn — graceful degradation.
   */
  fleetIdentityHosts: Record<string, number>;
  /**
   * `false` = WS still connecting, participants list not yet authoritative
   * — renders the loading placeholder. `true` = participants list is
   * authoritative — renders normally per sort discipline (or null if the
   * effective participant count is zero after self-exclusion).
   *
   * Slice 3's real relay adapter flips this true when the first participants
   * frame arrives. The Slice 1 stub returns false so the loading placeholder
   * is what displays for a Slice-2-era relay mount.
   */
  isReady: boolean;
  /** Optional wrapper class override. */
  className?: string;
  /**
   * Phase 97 Finding 2: the enclosing relay tab's tabId. Threaded to every
   * per-participant IdentityBadge child so each badge becomes a drag SOURCE
   * carrying the ROOM tab's tabId (dragging any badge drags the whole room
   * tab, per D-05). Undefined → badges are not drag-sourceable (parity with
   * pre-Phase-97 behavior). D-18 preserved: onClick is separately
   * not-supplied by MultiBadgeAnchor, so click remains inert; only
   * drag-source is enabled by tabId presence. The isMobile gate at
   * IdentityBadge.tsx:82 still applies (mobile stays non-draggable).
   */
  tabId?: string;
  /**
   * Cross-window drag descriptor pieces. Threaded to every per-participant
   * IdentityBadge child so a drop in a DIFFERENT same-origin Skynet window
   * can open a fresh relay-room tab for the same (roomId + roomTitle),
   * instead of planting the source-window's stranger tabId (which the target
   * doesn't know about, producing the "Session no longer exists" placeholder
   * that shipped as a rescue affordance 2026-09-17). Both fields are
   * optional; when absent, cross-window drops from this badge silent-reject.
   */
  relayRoomId?: string;
  relayRoomTitle?: string | null;
}

/**
 * Extract the localpart of an mxid (`@localpart:server` → `localpart`).
 * Lowercased for parity with sessionMatchKey / identityKey conventions.
 * Returns the empty string on malformed input.
 */
function extractLocalpart(mxid: string): string {
  if (!mxid.startsWith("@")) return "";
  const colon = mxid.indexOf(":");
  if (colon <= 1) return "";
  return mxid.slice(1, colon).toLowerCase();
}

/** A single person's badge cell: their picture (or initial) and name. */
function roomDragDescriptor(relayRoomId?: string, relayRoomTitle?: string | null) {
  return typeof relayRoomId === "string" && relayRoomId.length > 0
    ? {
        tabType: "terminal" as const,
        sessionKind: "relay-room" as const,
        relayRoomId,
        relayRoomTitle: relayRoomTitle ?? null,
      }
    : undefined;
}

function HumanBadgeCell({
  human,
  tight,
  tabId,
  relayRoomId,
  relayRoomTitle,
}: {
  human: HumanParticipant;
  tight: boolean;
  tabId?: string;
  relayRoomId?: string;
  relayRoomTitle?: string | null;
}) {
  return (
    <ParticipantCell role="human" mxid={human.mxid} name={human.displayName} tight={tight}>
      <RoomPersonBadge
        name={human.displayName}
        avatarUrl={personAvatarUrl(human.userId, human.avatarPath)}
        tabId={tabId}
        dragKey={extractLocalpart(human.mxid)}
        dragDescriptor={roomDragDescriptor(relayRoomId, relayRoomTitle)}
      />
    </ParticipantCell>
  );
}

/**
 * The cell every badge sits in. When the row is tight and names are hidden,
 * hovering shows the name (native tooltip) and a press-and-hold on a touch
 * screen shows it in a small label under the badge. A tap does nothing.
 */
function ParticipantCell({
  role,
  mxid,
  name,
  tight,
  children,
}: {
  role: "human" | "agent";
  mxid: string;
  name: string;
  tight: boolean;
  children: ReactNode;
}) {
  const [held, setHeld] = useState(false);
  // The label opens toward the middle of the pane so a long name never runs
  // off either edge.
  const [labelSide, setLabelSide] = useState<"left" | "right">("right");
  const lastPointer = useRef<string>("mouse");
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number }>({ timer: null, x: 0, y: 0 });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (hold.current.timer !== null) clearTimeout(hold.current.timer);
    hold.current.timer = null;
  };
  useEffect(
    () => () => {
      cancel();
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );
  const touchHandlers = tight
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          lastPointer.current = e.pointerType;
          if (e.pointerType === "mouse" && !isCoarsePointer()) return;
          cancel();
          const cell = e.currentTarget as HTMLElement;
          const pane = ((cell.offsetParent as HTMLElement | null)?.offsetParent as HTMLElement | null) ?? null;
          const r = cell.getBoundingClientRect();
          const p = pane?.getBoundingClientRect();
          setLabelSide(p && r.left - p.left < p.width / 2 ? "left" : "right");
          hold.current = {
            x: e.clientX,
            y: e.clientY,
            timer: setTimeout(() => {
              hold.current.timer = null;
              setHeld(true);
              if (hideTimer.current !== null) clearTimeout(hideTimer.current);
              hideTimer.current = setTimeout(() => setHeld(false), 2000);
            }, HOLD_MS),
          };
        },
        onPointerMove: (e: React.PointerEvent) => {
          if (
            Math.abs(e.clientX - hold.current.x) > MOVE_SLOP ||
            Math.abs(e.clientY - hold.current.y) > MOVE_SLOP
          ) {
            cancel();
          }
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onContextMenu: (e: React.MouseEvent) => {
          // A touch hold shows the name, never the system's own menu — even
          // on a touch laptop whose main pointer is a mouse.
          if (lastPointer.current !== "mouse" || isCoarsePointer()) e.preventDefault();
        },
      }
    : {};
  return (
    <div
      data-testid="relay-room-participant"
      data-role={role}
      data-mxid={mxid}
      className={CELL_BASE_CLASS}
      title={tight ? name : undefined}
      {...touchHandlers}
    >
      <span className="sr-only">{name}</span>
      {children}
      {tight && held && (
        <span
          data-testid="relay-room-participant-name"
          role="tooltip"
          className={cn(
            "pv-float absolute top-full mt-1 max-w-[180px]",
            labelSide === "left" ? "left-0" : "right-0",
            "truncate whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold text-[color:var(--k-t1)] pointer-events-none z-[102]",
          )}
        >
          {name}
        </span>
      )}
    </div>
  );
}

/**
 * A single agent's badge cell. Renders AgentBadgeWithMeter (Task 1 port —
 * plain badge + memory pie). Graceful degradation on
 * missing host mapping: renders the plain badge without appendage and
 * emits a structured warn.
 */
function AgentBadgeCell({
  agent,
  fleetIdentityHosts,
  tabId,
  relayRoomId,
  relayRoomTitle,
  tight,
}: {
  agent: AgentParticipant;
  fleetIdentityHosts: Record<string, number>;
  tabId?: string;
  relayRoomId?: string;
  relayRoomTitle?: string | null;
  tight: boolean;
}) {
  const { byKey } = useIdentities();
  const known = resolveMxidToIdentity(agent.mxid, byKey).identity ?? byKey.get(agent.identityKey.toLowerCase()) ?? null;
  const identityKey = agent.identityKey;
  const hostId = fleetIdentityHosts[identityKey];
  const dragDescriptor =
    typeof relayRoomId === "string" && relayRoomId.length > 0
      ? {
          tabType: "terminal" as const,
          sessionKind: "relay-room" as const,
          relayRoomId,
          relayRoomTitle: relayRoomTitle ?? null,
        }
      : undefined;
  // Phase 97 code-review Fix 2: log the no-host-mapping condition from a
  // useEffect gated on primitives so a re-render of the parent (e.g., a
  // participants frame update or any upstream state change) does NOT re-fire
  // the same warning. Same anti-pattern the Slice-6 pass fixed elsewhere —
  // any log inside a render body is proportional to render count. Fires on
  // transition into (or through) the no-mapping state; stays quiet otherwise.
  useEffect(() => {
    if (hostId !== undefined) return;
    // eslint-disable-next-line no-console
    console.warn({
      operation: "agent_badge_no_host_mapping",
      identityKey,
    });
  }, [identityKey, hostId]);
  const name = known?.displayName ?? identityKey;
  if (known === null) {
    // A member the app can't draw as an agent (not one of this user's
    // agents, or not loaded yet): a plain badge with their name, never blank.
    return (
      <ParticipantCell role="agent" mxid={agent.mxid} name={name} tight={tight}>
        <RoomPersonBadge
          name={name}
          avatarUrl={null}
          tabId={tabId}
          dragKey={identityKey}
          dragDescriptor={dragDescriptor}
        />
      </ParticipantCell>
    );
  }
  if (hostId === undefined) {
    // Defensive edge case — agent identity known but no live fleet mapping.
    // Graceful degradation: render the plain badge without appendage. The
    // structured warn above fires from a useEffect so re-renders don't spam.
    return (
      <ParticipantCell role="agent" mxid={agent.mxid} name={name} tight={tight}>
        <IdentityBadge
          identityKey={identityKey}
          tabId={tabId}
          dragDescriptor={dragDescriptor}
        />
      </ParticipantCell>
    );
  }
  return (
    <ParticipantCell role="agent" mxid={agent.mxid} name={name} tight={tight}>
      <AgentBadgeWithMeter
        identityKey={identityKey}
        mxid={agent.mxid}
        hostId={hostId}
        // One-identity-one-tmux-session convention: the identityKey IS the
        // tmux session name (lowercased) that the fleet publishes.
        tmuxSessionName={identityKey}
        tabId={tabId}
        relayRoomId={relayRoomId}
        relayRoomTitle={relayRoomTitle}
      />
    </ParticipantCell>
  );
}

/**
 * Root anchor class — Warning 2: kept identical between the loading branch
 * and the ready-with-participants branch so the position class parks at
 * the D-01 anchor from mount, regardless of adapter readiness.
 */
// Phase 97 Finding 4 UAT follow-up (2026-09-10): gap-1 (4px) was
// perceptually invisible because each cell wrapper was hard-coded 220px
// wide with the badge absolute-positioned to right-5 — the LARGE empty
// space to the left of each badge (~60px per cell) dominated any
// inter-cell gap. Cells shrunk to content below AND gap bumped to 13px
// per user's live-snippet tasting.
const ROOT_ANCHOR_CLASS =
  "absolute top-3 right-5 z-[101] flex flex-row-reverse items-start gap-2";

/** Pictures only: names hidden, pills shrink to the picture, closer gaps. */
const TIGHT_CLASS =
  "!gap-1 flex-wrap [&_.pv-badge-name]:hidden [&_.pv-identity-badge]:!p-[4px] [&_.pv-identity-badge]:!gap-0";

/** Room kept clear at the pane's left edge (the phone's back button). */
const ROW_LEFT_RESERVE_PX = 72;
/** The row's own distance from the pane's right edge (right-5). */
const ROW_RIGHT_OFFSET_PX = 20;

// Phase 97 Finding 4/5 UAT follow-up (2026-09-10): the participant cell
// wrappers were `h-[N] w-[220px]` with `IdentityBadge` absolute-positioned
// to `top-4 right-5` inside them — badge only occupied ~140px on the right
// of a 220px cell, leaving ~60px of empty space per cell to its left
// (F-4 perceived-gap root cause) AND the meter drawer (centered in the
// 220px cell via items-center in AgentBadgeWithMeter) sat ~20px LEFT of
// the badge's center (F-5 "meter up and to the left" root cause).
// Fix: shrink cell to content (drop fixed w/h) + un-absolute the badge
// inside the cell (arbitrary variants target IdentityBadge's
// `.pv-identity-breathe` root class, resetting position (relative, so the
// breathe overlay stays anchored to the badge)/top/right/z-index so the badge participates in its parent's flex-col flow).
const CELL_BASE_CLASS =
  "relative shrink-0 flex flex-col items-center " +
  "[&_.pv-identity-badge]:relative [&_.pv-identity-badge]:top-auto " +
  "[&_.pv-identity-badge]:right-auto [&_.pv-identity-badge]:z-auto";

export function MultiBadgeAnchor({
  participants,
  viewingUserMxid,
  fleetIdentityHosts,
  isReady,
  className,
  tabId,
  relayRoomId,
  relayRoomTitle,
}: MultiBadgeAnchorProps) {
  // D-03 self-exclusion filter for humans + humans-alphabetical sort.
  const humansOther = participants.humans
    .filter((h) => h.mxid !== viewingUserMxid)
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  // Agents alphabetical by identityKey (D-03).
  const agentsSorted = participants.agents
    .slice()
    .sort((a, b) => a.identityKey.localeCompare(b.identityKey));

  const totalCells = humansOther.length + agentsSorted.length;

  // Tight row: when every badge at full size won't fit across the pane,
  // every badge drops its name and the pictures sit closer, so everyone
  // stays on screen. The full-size width is measured whenever the members
  // change, and the row goes back to names once the pane is wide enough.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [tight, setTight] = useState(false);
  const [rowMaxWidth, setRowMaxWidth] = useState<number | null>(null);
  const fullWidth = useRef(0);
  const { byKey } = useIdentities();
  const memberKey = [...humansOther.map((h) => h.mxid), ...agentsSorted.map((a) => a.mxid)].join("|");
  // How each badge will draw (an agent's loaded name, whether it has a pie,
  // a person's name): when any of that changes, the full-size width does too.
  const drawKey = [
    ...humansOther.map((h) => h.displayName),
    ...agentsSorted.map((a) => {
      const known = byKey.get(a.identityKey.toLowerCase());
      return `${known?.displayName ?? "?"}:${fleetIdentityHosts[a.identityKey] ?? "-"}`;
    }),
  ].join("|");
  useLayoutEffect(() => {
    setTight(false);
    setRowMaxWidth(null);
    fullWidth.current = 0;
  }, [memberKey, drawKey]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const pane = root?.offsetParent as HTMLElement | null | undefined;
    if (!root || !pane) return;
    const check = () => {
      const available = pane.clientWidth - ROW_LEFT_RESERVE_PX - ROW_RIGHT_OFFSET_PX;
      if (!tight) {
        // The row grows leftward, where overflow isn't always counted in
        // its scroll width — so also add up the badges themselves.
        const cells = Array.from(root.children) as HTMLElement[];
        const gap = parseFloat(getComputedStyle(root).columnGap || "0") || 0;
        const summed =
          cells.reduce((w, c) => w + c.getBoundingClientRect().width, 0) +
          gap * Math.max(0, cells.length - 1);
        fullWidth.current = Math.max(root.scrollWidth, summed);
        if (fullWidth.current > available) {
          // eslint-disable-next-line no-console
          console.info({
            operation: "relay_room_badges_tight",
            members: totalCells,
            fullWidth: fullWidth.current,
            available,
          });
          setRowMaxWidth(Math.max(0, available));
          setTight(true);
        }
      } else if (fullWidth.current > 0 && fullWidth.current <= available) {
        setRowMaxWidth(null);
        setTight(false);
      } else {
        // Still tight: pictures wrap onto another line rather than run off.
        setRowMaxWidth(Math.max(0, available));
      }
    };
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(pane);
    // While names show, a badge changing size (a font or picture loading)
    // can make the row overflow — watch the badges themselves too.
    if (!tight) for (const c of Array.from(root.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [tight, memberKey, drawKey, isReady]);

  // Warning 2: loading discrimination. `isReady={false}` renders a subtle
  // placeholder so the relay tab does not appear empty during the
  // WS-connecting window. Anchor root class stays identical so the loading
  // placeholder parks at the D-01 anchor position.
  if (!isReady) {
    return (
      <div
        data-testid="multi-badge-anchor"
        className={cn(ROOT_ANCHOR_CLASS, className)}
      >
        <div
          data-testid="multi-badge-anchor-loading"
          className="opacity-40 text-xs text-[#e8e4d8] select-none"
        >
          loading participants...
        </div>
      </div>
    );
  }

  // Warning 2: empty discrimination. `isReady={true}` with zero non-self
  // participants renders null. In practice this shouldn't happen for a
  // relay room (implies at least one other participant), but the guard
  // keeps the render safe. The empty case renders NOTHING (no anchor, no
  // placeholder, no cells) so the harness anchor spot stays clean.
  if (totalCells === 0) {
    return null;
  }

  // Otherwise render the badge row per D-03 sort discipline. Order matters
  // — flex-row-reverse means the FIRST DOM child is RIGHTMOST visually.
  // Emit agents FIRST so agents sit closest to the harness anchor point;
  // humans SECOND so they grow further left (visually: humans-then-agents
  // reading left-to-right).
  return (
    <div
      ref={rootRef}
      data-testid="multi-badge-anchor"
      data-tight={tight ? "true" : "false"}
      className={cn(ROOT_ANCHOR_CLASS, tight && TIGHT_CLASS, className)}
      style={tight && rowMaxWidth !== null ? { maxWidth: rowMaxWidth } : undefined}
    >
      {agentsSorted.map((a) => (
        <AgentBadgeCell
          key={a.mxid}
          agent={a}
          fleetIdentityHosts={fleetIdentityHosts}
          tabId={tabId}
          relayRoomId={relayRoomId}
          relayRoomTitle={relayRoomTitle}
          tight={tight}
        />
      ))}
      {humansOther.map((h) => (
        <HumanBadgeCell
          key={h.mxid}
          human={h}
          tight={tight}
          tabId={tabId}
          relayRoomId={relayRoomId}
          relayRoomTitle={relayRoomTitle}
        />
      ))}
    </div>
  );
}
