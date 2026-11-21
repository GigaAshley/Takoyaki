import { authApi, handleApiError } from "@/main-axios";

/** Where Move to sends an app: the sidebar, or a project on the app's machine. */
export type AppMoveDestination = { to: "sidebar" } | { to: "project"; project: string };

/**
 * project-scoped apps: ask the app's machine to move it. The backend drops
 * the request in the app's folder; the machine carries it out within ~15s and
 * the sweep reports the app in its new place.
 */
export async function requestAppMove(
  hostId: number,
  slug: string,
  dest: AppMoveDestination,
): Promise<{ ok: true }> {
  try {
    const url = `/apps/${hostId}/${encodeURIComponent(slug)}/move`;
    const response = await authApi.post(url, dest);
    return response.data as { ok: true };
  } catch (error) {
    handleApiError(error, "move the app");
  }
}
