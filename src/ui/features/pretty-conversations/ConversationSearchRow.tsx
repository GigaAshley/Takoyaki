/**
 * Single result row for the conversation search modal.
 *
 * Anatomy (apple-ux: the kit's KitListRow, passages in its subtitle):
 *   Avatar (avatarUrl → initial-letter fallback, hue = result.colorHue,
 *   gold sheen for multi-role via .pv-multi-role's --pv-mr-sheen) + title
 *   (task ?? displayName ?? identityKey) with the relative time + archived
 *   chip on the title line; trailing = the three-dot menu only, floated
 *   over the title line's end, so the passages get the row's full width
 *   on a phone; subtitle = "Name ·
 *   Role[, Role]" then the passages. The avatar sits at the row's top.
 *   Body: up to 3 passages, each labelled as the conversation labels that
 *   bubble ("You", the agent's name, or a relay message's "Sender → To" as
 *   its card reads). Every case-insensitive occurrence of the
 *   query is wrapped in a <span data-part="hit"> — React text
 *   children only, never raw HTML (T-122-FE-01). "+N more matches" when the
 *   backend saw more than it sent.
 *
 * Fallback: rows the backend's passage pass didn't cover (passages empty)
 * render the single legacy snippet, split around hitStart/hitLength; when
 * hitStart is -1 the snippet renders unhighlighted.
 *
 * hostName is intentionally NOT rendered. Tasting dropped it; per user
 * 2026-09-29: "if tasting dropped something then we are not re-adding it".
 *
 * Archived pill retained — a click opens the view-only archived
 * conversation, where un-archiving happens.
 *
 * The row is focusable (role=button via KitListRow) so keyboard focus +
 * Enter/Space activate it. Parent (ConversationSearchModal) provides the
 * onClick. Parts carry data-part hooks (name, identity, role, avatar,
 * passage, speaker, hit, more) for tests.
 */

import type { CSSProperties } from "react";
import type {
  ConversationSearchPassage,
  ConversationSearchResult,
} from "@/api/conversation-search-api";
import { roleDisplayName } from "@/lib/role-display-name";
import { NEUTRAL_HUE } from "@/lib/identity-roles";
import { AvatarImage } from "@/components/avatar-image";
import { cn } from "@/lib/utils";
import type { Identity } from "@/api/identities-api";
import { useIdentities } from "@/state/identities-store";
import { useViewingUserMxid } from "@/state/viewing-user-store";
import {
  addressingFor,
  mxidLocalpart,
  partyForAddressee,
  partyForMxid,
  type RelayAddressing,
} from "@/features/pretty-view/relay-addressing";
import {
  useRelayRoomMembers,
  type RelayRoomMember,
} from "@/features/pretty-view/relay-room-members";
import { KitChip, KitListRow } from "@/components/kit";

const FALLBACK_HUE = 190;

export interface ConversationSearchRowProps {
  result: ConversationSearchResult;
  onClick: () => void;
  /** The fired query — every occurrence is highlighted in the passages. */
  query?: string;
  /** Injected in tests; falls back to Date.now() so relative-time rendering
   *  is deterministic under vitest. */
  now?: number;
}

/**
 * Buckets: <60s → "just now"; <60m → "N min ago"; <24h → "N hr ago";
 * <7d → "N d ago"; else absolute short date. Same rounding style as
 * chat "when" chips elsewhere in the app.
 */
function formatRelativeTime(mtimeMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.round((nowMs - mtimeMs) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay} d ago`;
  return new Date(mtimeMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const HIT_CLASS =
  "rounded-[3px] px-0.5 font-semibold text-[var(--k-t1)] bg-[var(--k-acc-soft)]";

/** Split `text` into React children with every case-insensitive
 *  occurrence of `query` wrapped in a highlight span. */
function highlightAll(text: string, query: string): Array<string | JSX.Element> {
  const q = query.trim();
  if (q.length === 0) return [text];
  // Case-insensitive regex over the ORIGINAL text — indices from a
  // toLowerCase() copy drift on characters whose lowercase differs in
  // length (e.g. "İ").
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const out: Array<string | JSX.Element> = [];
  let i = 0;
  for (const m of text.matchAll(re)) {
    const j = m.index ?? 0;
    if (m[0].length === 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <span key={j} data-part="hit" className={HIT_CLASS}>
        {m[0]}
      </span>,
    );
    i = j + m[0].length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/** "Sender → To" / "Sender → group with A, B" / "Sender sent a DM" — the
 *  relay card's who-line as text. */
function whoLine(sender: string, addressing: RelayAddressing): string {
  if (addressing.kind === "dm") return `${sender} → ${addressing.to.name}`;
  if (addressing.kind === "group") {
    return `${sender} → group with ${addressing.to.map((p) => p.name).join(", ")}`;
  }
  return `${sender} sent a DM`;
}

/** The passage's label, worded the way the conversation labels the bubble.
 *  Relay messages name their parties the way the relay cards do, from the
 *  room's members when they're known (`members`), else the same fallbacks. */
export function speakerLabel(
  passage: ConversationSearchPassage,
  agent: { name: string; key: string },
  byKey: Map<string, Identity>,
  viewerMxid: string | null,
  members: RelayRoomMember[] | null,
): string {
  switch (passage.speaker) {
    case "user":
      return "You";
    case "agent":
      return agent.name;
    case "relay": {
      if (passage.relayFrom) {
        const addressing = addressingFor(mxidLocalpart(passage.relayFrom), members, byKey, {
          name: agent.name,
          hue: null,
          you: false,
        });
        return whoLine(partyForMxid(passage.relayFrom, byKey).name, addressing);
      }
      const addressing = addressingFor(
        agent.key.toLowerCase(),
        members,
        byKey,
        passage.relayTo ? partyForAddressee(passage.relayTo, byKey, viewerMxid) : null,
      );
      // A message to you shows as the agent's own bubble.
      if (addressing.kind === "dm" && addressing.to.you) return agent.name;
      return whoLine(agent.name, addressing);
    }
  }
}

function PassageSpeaker({
  passage,
  agent,
  hostId,
}: {
  passage: ConversationSearchPassage;
  agent: { name: string; key: string };
  hostId: number;
}): JSX.Element {
  const { byKey } = useIdentities();
  const viewerMxid = useViewingUserMxid();
  const members = useRelayRoomMembers(
    passage.speaker === "relay" ? passage.relayRoom ?? null : null,
    hostId,
  );
  return (
    <span data-part="speaker" className="text-[11.5px] font-semibold text-[var(--k-t3)]">
      {speakerLabel(passage, agent, byKey, viewerMxid, members)}
    </span>
  );
}

export function ConversationSearchRow({
  result,
  onClick,
  query = "",
  now,
}: ConversationSearchRowProps): JSX.Element {
  const name = result.displayName ?? result.identityKey;
  const title = result.aiTitle ?? result.task ?? name;
  const roles = result.roles ?? [];
  // No roles and no colorHue: the neutral grey every surface uses for it.
  const neutralLook = result.colorHue == null && roles.length === 0;
  const hue = result.colorHue ?? (neutralLook ? NEUTRAL_HUE : FALLBACK_HUE);
  const when = formatRelativeTime(result.transcriptMtime, now ?? Date.now());
  const rolesLabel = roles
    .map((r) => roleDisplayName(r.slug, r.displayName))
    .join(", ");
  const isMultiRole = roles.length > 1;

  const SNIPPET_CLASS =
    "block text-[12.5px] leading-[1.5] text-[var(--k-t2)] [overflow-wrap:anywhere] line-clamp-3";

  const passages = result.passages ?? [];
  let body: JSX.Element;
  if (passages.length > 0) {
    const more = (result.matchCount ?? passages.length) - passages.length;
    body = (
      <span className="flex flex-col gap-1.5 mt-1.5" data-part="passages">
        {passages.map((p, i) => (
          <span
            key={i}
            data-part="passage"
            data-speaker={p.speaker}
            className="flex flex-col gap-0.5 pl-2 border-l-2 border-[var(--k-hair2)]"
          >
            <PassageSpeaker
              passage={p}
              agent={{ name, key: result.identityKey }}
              hostId={result.hostId}
            />
            <span className={SNIPPET_CLASS}>{highlightAll(p.text, query)}</span>
          </span>
        ))}
        {/* matchCountCapped = the scan stopped before the end of the
            transcript, so there may be more even when `more` is 0 (the
            capped lines were tool output, not text). */}
        {(more > 0 || result.matchCountCapped) && (
          <span data-part="more" className="block pl-2.5 text-[12px] text-[var(--k-t3)]">
            {result.matchCountCapped
              ? more > 0
                ? `${more}+ more matches in this conversation`
                : "More matches in this conversation"
              : `+${more} more ${more === 1 ? "match" : "matches"} in this conversation`}
          </span>
        )}
      </span>
    );
  } else if (result.hitStart >= 0 && result.hitLength > 0) {
    const before = result.snippet.slice(0, result.hitStart);
    const hit = result.snippet.slice(
      result.hitStart,
      result.hitStart + result.hitLength,
    );
    const after = result.snippet.slice(result.hitStart + result.hitLength);
    body = (
      <span className={cn(SNIPPET_CLASS, "mt-1.5")}>
        {before}
        <span data-part="hit" className={HIT_CLASS}>{hit}</span>
        {after}
      </span>
    );
  } else {
    body = <span className={cn(SNIPPET_CLASS, "mt-1.5")}>{result.snippet}</span>;
  }

  return (
    <KitListRow
      onActivate={onClick}
      data-testid={`conversation-search-row-${result.transcriptPath}`}
      data-archived={result.isArchived ? "true" : "false"}
      data-hue={hue}
      dim={result.isArchived}
      className={cn(
        "!items-start [&_.k-item-main]:!items-start",
        isMultiRole && "pv-multi-role", neutralLook && "pv-neutral")}
      style={isMultiRole ? ({ "--pv-mr-h": String(hue) } as CSSProperties) : undefined}
      avatarColor={
        isMultiRole
          ? `var(--pv-mr-sheen), hsl(${hue}, 42%, 40%)`
          : `hsl(${hue}, 42%, 40%)`
      }
      avatar={
        <span data-part="avatar" className="contents">
          <AvatarImage src={result.avatarUrl} name={name} />
        </span>
      }
      title={
        <span className={"flex items-center gap-2 min-w-0"}>
          <span data-part="name" className="truncate min-w-0 flex-1">{title}</span>
          <span className="text-[12px] font-normal text-[var(--k-t3)] whitespace-nowrap">{when}</span>
          {result.isArchived && <KitChip>archived</KitChip>}
        </span>
      }
      wrapSubtitle
      subtitle={
        <>
          <span className="flex items-center gap-1.5 min-w-0 overflow-hidden whitespace-nowrap">
            <span data-part="identity" className="truncate">{name}</span>
            {rolesLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span data-part="role" className="truncate font-semibold text-[var(--k-t2)]">
                  {rolesLabel}
                </span>
              </>
            )}
          </span>
          {body}
        </>
      }
    />
  );
}
