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
let failedSrcs: { owner: string | null; list: string[] } | null = null;

function loadFailedSrcs(): string[] {
  const owner = getCurrentUser();
  if (failedSrcs !== null && failedSrcs.owner === owner) return failedSrcs.list;
  const raw = owner ? readUserScopedCache<unknown>(FAILED_SRCS_KEY, ["skynet:avatar-failed-srcs:v1"]) : null;
  const list = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
  failedSrcs = { owner, list };
  return list;
}

function saveFailedSrcs(list: string[]): void {
  failedSrcs = { owner: getCurrentUser(), list };
  writeUserScopedCache(FAILED_SRCS_KEY, list);
}

export function rememberAvatarFailed(src: string): void {
  const list = loadFailedSrcs();
  if (list.includes(src)) return;
  saveFailedSrcs([...list, src].slice(-FAILED_SRCS_MAX));
}

export function forgetAvatarFailed(src: string): void {
  const list = loadFailedSrcs();
  if (!list.includes(src)) return;
  saveFailedSrcs(list.filter((s) => s !== src));
}

export function isAvatarKnownFailed(src: string): boolean {
  return loadFailedSrcs().includes(src);
}

/** Test-only: forget the in-memory copy so the next read comes from storage. */
export function __resetAvatarFailuresForTest(): void {
  failedSrcs = null;
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
    if (!src || !knownFailed || typeof Image === "undefined") return;
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
