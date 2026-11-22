// ─── PillFrame ───────────────────────────────────────────────────────────────
//
// The pill at the top-center of a conversation pane, without anything about
// which conversation it is: the floating solid pill with a picture and a
// line of text, the ⋯ menu (also on right-click and press-and-hold), and the
// pane drag. TaskPill fills it in for a running agent; the new-conversation
// pane fills it in for a conversation that hasn't started yet — same pill,
// so the two can't drift apart.
//
// Slots:
//   - `picture` + `label` — inside the pill's primary button (a click on the
//     pill calls `onOpen`). `editor`, when given, takes the button's place
//     (e.g. renaming in place), beside the picture — never inside a button.
//   - `beforeMenu` — just before the ⋯ (TaskPill's memory pie).
//   - `side` — round buttons hanging off the pill's right edge.

import { useCallback, useEffect, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { KitScopeContext, type KitScopeValue } from "@/components/kit/scope";
import {
  RowKebabMenu,
  useRowKebabContextMenu,
  type RowKebabMenuItem,
} from "@/features/pretty-conversations/RowKebabMenu";

// Each side keeps the pane margin plus room for three round buttons, so the
// pill can use the rest of the width and stay centered.
export const PILL_SIDE_BUTTON_PX = 40;
const SIDE_RESERVE_PX =
  16 + 8 + PILL_SIDE_BUTTON_PX + 8 + PILL_SIDE_BUTTON_PX + 8 + PILL_SIDE_BUTTON_PX;
// A pill that never has round buttons beside it keeps only the pane margin
// and room for the phone's floating back button.
const BARE_RESERVE_PX = 56;

// Below this much room for the pill, the pill counts as narrow (a phone, a
// narrow split pane) — TaskPill's pie then pulses instead of saying words.
const NARROW_PILL_PX = 280;

// The pill's ⋯ menu takes the kit look, like the sidebar's and pane bars'.
const PILL_KIT_SCOPE: KitScopeValue = { hue: 220 };

export interface PillFrameProps {
  picture: ReactNode;
  label: ReactNode;
  /** Replaces the primary button (picture stays) — e.g. a rename field. */
  editor?: ReactNode;
  tooltip?: string;
  onOpen: () => void;
  openAriaLabel: string;
  menuItems: RowKebabMenuItem[];
  menuAriaLabel: string;
  /** Present → the pill is the pane's drag handle. */
  onDragStart?: (e: ReactDragEvent<HTMLElement>) => void;
  beforeMenu?: (narrow: boolean) => ReactNode;
  side?: ReactNode;
  /** False → no room kept for round buttons beside the pill (it never has any). */
  sideButtons?: boolean;
}

export function PillFrame({
  picture,
  label,
  editor,
  tooltip,
  onOpen,
  openAriaLabel,
  menuItems,
  menuAriaLabel,
  onDragStart,
  beforeMenu,
  side,
  sideButtons = true,
}: PillFrameProps) {
  const reserve = sideButtons ? SIDE_RESERVE_PX : BARE_RESERVE_PX;
  const contextMenu = useRowKebabContextMenu(menuItems);
  // The room the pill may take is the pane's width less the side reserves.
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);
  const anchorRef = useCallback((el: HTMLDivElement | null) => setPaneEl(el?.parentElement ?? null), []);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!paneEl) return;
    // 0 = not laid out yet; keep the wide look until there's a real width.
    const measure = () => {
      const w = paneEl.clientWidth;
      setNarrow(w > 0 && w - reserve * 2 < NARROW_PILL_PX);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(paneEl);
    return () => ro.disconnect();
  }, [paneEl, reserve]);

  return (
    <div
      ref={anchorRef}
      data-testid="pv-task-pill-anchor"
      // inset-x-0 + mx-auto + w-fit centers it while letting it grow up to
      // maxWidth (a left:50% anchor would cap it at half the pane).
      className="absolute top-3 inset-x-0 mx-auto w-fit z-[101] flex"
      style={{ maxWidth: `calc(100% - ${reserve * 2}px)` }}
    >
      <div
        data-testid="pv-task-pill"
        title={tooltip}
        onClick={editor ? undefined : () => onOpen()}
        onContextMenu={contextMenu.onContextMenu}
        {...contextMenu.holdProps}
        draggable={onDragStart !== undefined && !editor}
        onDragStart={onDragStart}
        // Solid and neutral (shape-conversation-view), no blur — it floats
        // over the scrolling chat. The agent's colour is the ring on its
        // picture; the menu is the kit's ⋯.
        className="pv-float relative flex flex-row items-center gap-0.5 h-10 min-w-0 max-w-full rounded-full pl-1 pr-1 cursor-pointer select-none [-webkit-touch-callout:none]"
      >
        {editor ? (
          <div className="flex flex-row items-center gap-[9px] h-8 min-w-0 pl-0.5 pr-2">
            {picture}
            {editor}
          </div>
        ) : (
          // The pill's primary control for keyboard / screen readers; its
          // click bubbles to the pill root, which owns the open. A sibling of
          // the kebab, never its ancestor.
          <button
            type="button"
            aria-label={openAriaLabel}
            data-testid="pv-task-pill-open"
            className="flex flex-row items-center gap-[9px] h-8 min-w-0 pl-0.5 pr-2 text-left cursor-pointer rounded-full hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            {picture}
            <span
              data-testid="pv-task-pill-label"
              className="truncate min-w-0 text-[color:var(--k-t1)]"
              style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.005em" }}
            >
              {label}
            </span>
          </button>
        )}
        {beforeMenu?.(narrow)}
        {menuItems.length > 0 && (
          // Its own (cancelled) drag source so a press-and-move starting on
          // the ⋮ doesn't drag the pane.
          <span
            className="shrink-0 inline-flex"
            draggable
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <KitScopeContext.Provider value={PILL_KIT_SCOPE}>
              <RowKebabMenu
                items={menuItems}
                ariaLabel={menuAriaLabel}
                testId="pv-task-pill-kebab-trigger"
                triggerClassName="rounded-full"
              />
            </KitScopeContext.Provider>
          </span>
        )}
      </div>
      {side}
      {contextMenu.menu}
    </div>
  );
}
