// Sidebar motion for real changes: when something in the sidebar moves
// because the data changed (a conversation rises, one arrives, one leaves),
// it slides to its new place instead of jumping; an arriving item fades in;
// a leaving item fades out where it was while the items below close the gap.
//
// How: after every commit the position of each tracked item (rows, project
// apps, app tiles, section and project headers, empty-section notes) is
// recorded in the scroll region's content coordinates. On the next commit,
// anything whose position changed is drawn at its old place and animated to
// its new one (a FLIP). Removed items are caught by a mutation observer —
// the removed element itself is parked in the scroll region at its old
// place and faded out.
//
// Nothing animates on the first paint, while the sidebar search is in use,
// across a resize, or with the device's reduce-motion setting on — those
// just snap.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const SIDEBAR_MOTION_MS = 250;
const LEAVE_MS = 200;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

const TRACKED_SELECTOR = [
  "[data-conversation-id]",
  "[data-app-key]",
  '[data-testid^="pv-project-section-header-"]',
  '[data-testid="pretty-conversations-apps-header"]',
  '[data-testid="pretty-conversations-pinned-header"]',
  '[data-testid="pretty-conversations-pinned-empty"]',
  '[data-testid="pv-projects-super-header"]',
  '[data-testid="pretty-conversations-project-empty"]',
  '[data-testid="pv-flat-middle-section-header"]',
  '[data-testid="pv-flat-middle-empty"]',
  '[data-testid="rdp-divider"]',
].join(",");

type Place = { top: number; left: number; width: number; height: number };

function baseKey(el: Element): string {
  const conv = el.getAttribute("data-conversation-id");
  if (conv !== null) return `c:${conv}`;
  const app = el.getAttribute("data-app-key");
  if (app !== null) return `a:${app}:${el.getAttribute("data-testid") ?? ""}`;
  return `t:${el.getAttribute("data-testid") ?? ""}`;
}

/** Tracked items under `root`, keyed; repeats of a key get an occurrence suffix. */
function trackedItems(root: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  const seen = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>(TRACKED_SELECTOR)) {
    // A leaving item fading out isn't part of the sidebar any more.
    if (el.closest("[data-sidebar-leaving]")) continue;
    // An item nested in another tracked item moves with it.
    const outer = el.parentElement?.closest(TRACKED_SELECTOR);
    if (outer && root.contains(outer)) continue;
    const k = baseKey(el);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    out.set(n === 0 ? k : `${k}#${n}`, el);
  }
  return out;
}

function placeOf(el: HTMLElement, root: HTMLElement, rootRect: DOMRect): Place {
  const r = el.getBoundingClientRect();
  return {
    top: r.top - rootRect.top + root.scrollTop,
    left: r.left - rootRect.left + root.scrollLeft,
    width: r.width,
    height: r.height,
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function canAnimate(el: Element): el is HTMLElement {
  return typeof (el as HTMLElement).animate === "function";
}

/**
 * @param rootRef the sidebar's scroll region.
 * @param enabled false while the change comes from the user filtering (search).
 */
export function useSidebarMotion(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  const places = useRef<Map<string, Place> | null>(null);
  const enabledRef = useRef(enabled);
  // Positions recorded before the latest commit, kept for the removal
  // observer (which runs after this commit's layout effect has re-measured).
  const previousPlaces = useRef<Map<string, Place> | null>(null);
  const lastSkipReason = useRef<string | null>(null);

  // Every commit: compare with the last recorded positions, animate the
  // difference, record the new positions.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const items = trackedItems(root);
    const next = new Map<string, Place>();
    for (const [k, el] of items) next.set(k, placeOf(el, root, rootRect));

    const prev = places.current;
    previousPlaces.current = prev;
    places.current = next;

    const skip =
      prev === null || prev.size === 0 ? "first-paint"
      : !enabledRef.current ? "search"
      : prefersReducedMotion() ? "reduced-motion"
      : null;
    if (skip !== null) {
      lastSkipReason.current = skip;
      return;
    }
    lastSkipReason.current = null;

    let moved = 0;
    let arrived = 0;
    for (const [k, el] of items) {
      if (!canAnimate(el)) continue;
      const was = prev.get(k);
      const now = next.get(k)!;
      if (was === undefined) {
        arrived += 1;
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SIDEBAR_MOTION_MS, easing: EASING });
        continue;
      }
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      moved += 1;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: SIDEBAR_MOTION_MS, easing: EASING },
      );
    }
    if (moved + arrived > 0) {
      console.info({ operation: "sidebar_motion", moved, arrived });
    }
  });

  // Track whether motion is allowed this commit (read by the effects).
  enabledRef.current = enabled;

  // Removed items: park the detached element where it was and fade it out.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((records) => {
      if (lastSkipReason.current !== null) return;
      const prev = previousPlaces.current;
      if (!prev) return;
      const current = places.current;
      let left = 0;
      for (const rec of records) {
        for (const node of rec.removedNodes) {
          if (!(node instanceof HTMLElement) || node.isConnected) continue;
          if (node.hasAttribute("data-sidebar-leaving")) continue;
          const removed: HTMLElement[] = node.matches(TRACKED_SELECTOR)
            ? [node]
            : Array.from(node.querySelectorAll<HTMLElement>(TRACKED_SELECTOR));
          for (const el of removed) {
            const k = baseKey(el);
            // Still present under the same key = it moved, not left.
            if (current?.has(k)) continue;
            const was = prev.get(k);
            if (!was || !canAnimate(el)) continue;
            left += 1;
            el.style.position = "absolute";
            el.style.top = `${was.top}px`;
            el.style.left = `${was.left}px`;
            el.style.width = `${was.width}px`;
            el.style.height = `${was.height}px`;
            el.style.margin = "0";
            el.style.pointerEvents = "none";
            el.setAttribute("aria-hidden", "true");
            el.setAttribute("data-sidebar-leaving", "true");
            root.appendChild(el);
            const anim = el.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: LEAVE_MS,
              easing: EASING,
              fill: "forwards",
            });
            const done = () => el.remove();
            anim.onfinish = done;
            anim.oncancel = done;
          }
        }
      }
      if (left > 0) console.info({ operation: "sidebar_motion_left", left });
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rootRef]);

  // A resize moves everything without a data change: re-record, don't animate.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = rootRef.current;
      if (!r || places.current === null) return;
      const rootRect = r.getBoundingClientRect();
      const next = new Map<string, Place>();
      for (const [k, el] of trackedItems(r)) next.set(k, placeOf(el, r, rootRect));
      places.current = next;
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [rootRef]);
}
