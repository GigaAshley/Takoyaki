// The signed-in user's own sidebar details (name, picture, admin) saved per
// user, so the sidebar footer paints on first load instead of filling in once
// /users/me answers. A paint hint only: the fresh answer replaces it.

import { readUserScopedCache, writeUserScopedCache } from "@/state/user-scoped-cache";

const ME_CACHE_KEY = "skynet:me-cache:v1";

export type CachedMe = {
  username: string | null;
  userId: string | null;
  avatarPath: string | null;
  isAdmin: boolean;
};

const optString = (v: unknown): v is string | null => v === null || typeof v === "string";

export function readMeCache(): CachedMe | null {
  const p = readUserScopedCache<unknown>(ME_CACHE_KEY);
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  if (!optString(r.username) || !optString(r.userId) || !optString(r.avatarPath)) return null;
  if (typeof r.isAdmin !== "boolean") return null;
  return { username: r.username, userId: r.userId, avatarPath: r.avatarPath, isAdmin: r.isAdmin };
}

export function writeMeCache(me: CachedMe): void {
  writeUserScopedCache(ME_CACHE_KEY, me);
}
