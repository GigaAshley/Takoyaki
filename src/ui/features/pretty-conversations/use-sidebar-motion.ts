// Sidebar motion for real changes: when something in the sidebar moves
// because the data changed (a conversation rises, one arrives, one leaves),
// it slides to its new place instead of jumping; an arriving item fades in;
// a leaving item fades out where it was while the items below close the gap.
//
// How: the position of each tracked item (rows, project apps, app tiles,
// section and project headers, empty-section notes) is recorded in the
// scroll region's content coordinates. After a commit that added, removed or
// reordered anything in the list (seen through a mutation observer — most
// renders change nothing structural and do no layout work at all), anything
// whose position changed is drawn at its old place and animated to its new
// one (a FLIP). A removed item is parked in the scroll region at its old
// place and faded out.
//
// Nothing animates on the first paint, while the sidebar search is in use,
// when the sidebar's width changed (a resize), or with the device's
// reduce-motion setting on — those just snap.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const SIDEBAR_MOTION_MS = 250;
const LEAVE_MS = 120;
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

const LEAVING_ATTR = "data-sidebar-leaving";

/**
 * Whether `el` should be skipped: it sits in a leaving item, or inside another
 * tracked item (it moves with that one). Walks up to `root` only.
 */
function nestedOrLeaving(el: HTMLElement, root: HTMLElement): boolean {
  if (el.hasAttribute(LEAVING_ATTR)) return true;
  for (let p = el.parentElement; p !== null && p !== root; p = p.parentElement) {
    if (p.hasAttribute(LEAVING_ATTR) || p.matches(TRACKED_SELECTOR)) return true;
  }
  return false;
}

/** Tracked items under `root`, keyed; repeats of a key get an occurrence suffix. */
function trackedItems(root: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  const seen = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>(TRACKED_SELECTOR)) {
    if (nestedOrLeaving(el, root)) continue;
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

/** The translate a running slide currently applies to `el` (0,0 if none). */
function currentTranslate(el: HTMLElement): { x: number; y: number } {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return { x: 0, y: 0 };
  const m = /^matrix\(([^)]+)\)$/.exec(t);
  if (m) {
    const v = m[1].split(",").map(Number);
    return { x: v[4] || 0, y: v[5] || 0 };
  }
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
  if (m3) {
    const v = m3[1].split(",").map(Number);
    return { x: v[12] || 0, y: v[13] || 0 };
  }
  return { x: 0, y: 0 };
}

/** Whether a mutation record changed the list itself (not a fading ghost). */
function structural(rec: MutationRecord): boolean {
  if (rec.type !== "childList") return false;
  const real = (n: Node) => !(n instanceof HTMLElement && n.hasAttribute(LEAVING_ATTR));
  return [...rec.addedNodes].some(real) || [...rec.removedNodes].some(real);
}

/**
 * @param rootRef the sidebar's scroll region.
 * @param enabled false while the change comes from the user filtering (search).
 */
export function useSidebarMotion(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  const places = useRef<Map<string, Place> | null>(null);
  const width = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const observer = useRef<MutationObserver | null>(null);
  // Something changed the list outside a commit (seen by the observer's own
  // callback): measure on the next commit even if it brings no records.
  const dirtyOutside = useRef(false);
  // Slides in progress, per element (fades are left to finish on their own).
  const slides = useRef(new Map<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (observer.current === null && typeof MutationObserver !== "undefined") {
      observer.current = new MutationObserver((recs) => {
        if (recs.some(structural)) dirtyOutside.current = true;
      });
      observer.current.observe(root, { childList: true, subtree: true });
    }
    const records = observer.current?.takeRecords() ?? [];
    const changed = dirtyOutside.current || records.some(structural) || observer.current === null;
    dirtyOutside.current = false;
    const rootWidth = root.clientWidth;
    const resized = width.current !== null && width.current !== rootWidth;
    width.current = rootWidth;
    // Nothing added, removed or reordered: nothing can have moved.
    if (places.current !== null && !changed && !resized) return;

    const prev = places.current;
    const items = trackedItems(root);
    const rootRect = root.getBoundingClientRect();
    // Where each item sits (its layout place) and where it shows on screen
    // (layout plus whatever slide it's in the middle of).
    const next = new Map<string, Place>();
    const onScreen = new Map<string, Place>();
    for (const [k, el] of items) {
      const shown = placeOf(el, root, rootRect);
      onScreen.set(k, shown);
      if (slides.current.has(el)) {
        const t = currentTranslate(el);
        next.set(k, { ...shown, top: shown.top - t.y, left: shown.left - t.x });
      } else {
        next.set(k, shown);
      }
    }
    places.current = next;

    const hadRows = prev !== null && [...prev.keys()].some((k) => k.startsWith("c:"));
    const skip =
      !hadRows ? "first-paint"
      : resized ? "resize"
      : !enabledRef.current ? "search"
      : prefersReducedMotion() ? "reduced-motion"
      : null;
    if (skip !== null) {
      for (const a of slides.current.values()) a.cancel();
      slides.current.clear();
      return;
    }

    // Items that left in this commit fade out where they were.
    let left = 0;
    for (const rec of records) {
      for (const node of rec.removedNodes) {
        if (!(node instanceof HTMLElement) || node.isConnected || node.hasAttribute(LEAVING_ATTR)) continue;
        const removed = node.matches(TRACKED_SELECTOR)
          ? [node]
          : Array.from(node.querySelectorAll<HTMLElement>(TRACKED_SELECTOR));
        for (const el of removed) {
          const k = baseKey(el);
          if (next.has(k)) continue; // still here under the same key: it moved
          const was = prev!.get(k);
          if (!was || !canAnimate(el)) continue;
          left += 1;
          el.style.position = "absolute";
          el.style.top = `${was.top}px`;
          el.style.left = `${was.left}px`;
          el.style.width = `${was.width}px`;
          el.style.height = `${was.height}px`;
          el.style.margin = "0";
          el.style.transform = "none";
          el.style.pointerEvents = "none";
          el.setAttribute("aria-hidden", "true");
          el.setAttribute(LEAVING_ATTR, "true");
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

    let moved = 0;
    let arrived = 0;
    for (const [k, el] of items) {
      if (!canAnimate(el)) continue;
      const was = prev!.get(k);
      const now = next.get(k)!;
      if (was === undefined) {
        arrived += 1;
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SIDEBAR_MOTION_MS, easing: EASING });
        continue;
      }
      // Same place as before: a slide still running carries on untouched.
      if (Math.abs(was.left - now.left) < 0.5 && Math.abs(was.top - now.top) < 0.5) continue;
      // It moved: start from where it showed just before this commit — its old
      // place plus the offset of any slide still running (that offset is how
      // far it shows from its layout place now).
      const shown = onScreen.get(k)!;
      const startX = was.left - now.left + (shown.left - now.left);
      const startY = was.top - now.top + (shown.top - now.top);
      slides.current.get(el)?.cancel();
      moved += 1;
      const anim = el.animate(
        [{ transform: `translate(${startX}px, ${startY}px)` }, { transform: "translate(0, 0)" }],
        { duration: SIDEBAR_MOTION_MS, easing: EASING },
      );
      slides.current.set(el, anim);
      anim.onfinish = () => {
        if (slides.current.get(el) === anim) slides.current.delete(el);
      };
    }
    // Forget slides on elements that are gone.
    for (const el of slides.current.keys()) if (!el.isConnected) slides.current.delete(el);
    if (moved + arrived + left > 0) {
      console.info({ operation: "sidebar_motion", moved, arrived, left });
    }
  });

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );
}
