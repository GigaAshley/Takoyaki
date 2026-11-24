import { useEffect, useState, type CSSProperties } from "react";
import { getCurrentUser, readUserScopedCache, writeUserScopedCache } from "@/state/user-scoped-cache";

/** First letter of `name`, upper-cased; "?" when there is none. */
export function initialOf(name: string | null | undefined): string {
  const ch = (name ?? "").trim()[0];
  return ch ? ch.toUpperCase() : "?";
}

// Avatar URLs that failed to load, remembered across page loads (per signed-in
// user, like the rest of the sidebar's saved copy) so an agent with no picture
// paints its initial straight away instead of a beat later (after the image's
// error). Bounded; newest last.
const FAILED_SRCS_KEY = "skynet:avatar-failed-srcs:v2";
const FAILED_SRCS_MAX = 500;
// Read once per page (a sign-in as someone else reloads the page). In memory
// as a Set; written back in one batch at the end of the current task.
let failedSrcs: Set<string> | null = null;
// Failures seen on this page — not worth an immediate background retry.
const failedThisPage = new Set<string>();
let saveQueued = false;

function loadFailedSrcs(): Set<string> {
  if (failedSrcs !== null) return failedSrcs;
  const raw = getCurrentUser() ? readUserScopedCache<unknown>(FAILED_SRCS_KEY, ["skynet:avatar-failed-srcs:v1"]) : null;
  failedSrcs = new Set(Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : []);
  return failedSrcs;
}

function queueSave(): void {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    const list = [...loadFailedSrcs()].slice(-FAILED_SRCS_MAX);
    writeUserScopedCache(FAILED_SRCS_KEY, list);
  });
}

export function rememberAvatarFailed(src: string): void {
  failedThisPage.add(src);
  const set = loadFailedSrcs();
  if (set.has(src)) return;
  set.add(src);
  if (set.size > FAILED_SRCS_MAX) set.delete(set.values().next().value as string);
  queueSave();
}

export function forgetAvatarFailed(src: string): void {
  const set = loadFailedSrcs();
  if (!set.delete(src)) return;
  queueSave();
}

export function isAvatarKnownFailed(src: string): boolean {
  return loadFailedSrcs().has(src);
}

/** Test-only: forget the in-memory copy so the next read comes from storage. */
export function __resetAvatarFailuresForTest(): void {
  failedSrcs = null;
  failedThisPage.clear();
}

/**
 * An agent's avatar image, or its initial when there is no image or the image
 * fails to load — e.g. an agent with no roles and no avatar of its own, whose
 * avatar URL has nothing to serve. The swap happens on the image's error, and
 * the empty `alt` keeps browsers from drawing a broken-image glyph meanwhile.
 * A new `src` gets a fresh attempt. A src that failed on an earlier load
 * paints the initial at once, and is quietly tried again in the background in
 * case a picture has appeared since.
 *
 * The caller's circle (background, border, size) is either the container this
 * sits in, or `initialClassName` / `initialStyle` when the image itself is
 * the circle.
 */
export function AvatarImage({
  src,
  name,
  className,
  style,
  initialClassName,
  initialStyle,
}: {
  src: string | null | undefined;
  name: string | null | undefined;
  className?: string;
  style?: CSSProperties;
  initialClassName?: string;
  initialStyle?: CSSProperties;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(() =>
    src && isAvatarKnownFailed(src) ? src : null,
  );
  // A src this element hasn't seen fail yet starts from what earlier loads learned.
  if (src && failedSrc !== src && isAvatarKnownFailed(src)) setFailedSrc(src);

  const knownFailed = !!src && failedSrc === src;
  useEffect(() => {
    // A picture that failed on this very page isn't retried straight away.
    if (!src || !knownFailed || failedThisPage.has(src) || typeof Image === "undefined") return;
    let live = true;
    const probe = new Image();
    probe.onload = () => {
      forgetAvatarFailed(src);
      if (live) setFailedSrc(null);
    };
    probe.src = src;
    return () => {
      live = false;
      probe.onload = null;
    };
  }, [src, knownFailed]);

  if (!src || knownFailed) {
    return (
      <span data-testid="avatar-initial" className={initialClassName} style={initialStyle}>
        {initialOf(name)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={className}
      style={style}
      onLoad={() => forgetAvatarFailed(src)}
      onError={() => {
        rememberAvatarFailed(src);
        setFailedSrc(src);
      }}
    />
  );
}
