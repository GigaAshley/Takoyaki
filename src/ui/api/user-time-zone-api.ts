/**
 * Person time zone — frontend client for the signed-in person's own zone.
 *
 *   GET    /users/me/time-zone          → { timeZone: string | null, pinned }
 *   POST   /users/me/time-zone/browser  → same, after this browser's report
 *   PUT    /users/me/time-zone/pin      → same, pinned
 *   DELETE /users/me/time-zone/pin      → same, following the browser again
 */

import { authApi, handleApiError } from "@/main-axios";

export type MyTimeZone = { timeZone: string | null; pinned: boolean };

function wire(data: unknown): MyTimeZone {
  const d = data as Partial<MyTimeZone> | null;
  return {
    timeZone: typeof d?.timeZone === "string" ? d.timeZone : null,
    pinned: d?.pinned === true,
  };
}

export async function getMyTimeZone(): Promise<MyTimeZone> {
  try {
    return wire((await authApi.get("/users/me/time-zone")).data);
  } catch (error) {
    handleApiError(error, "get time zone");
  }
}

export async function reportBrowserTimeZone(timeZone: string): Promise<MyTimeZone> {
  try {
    return wire((await authApi.post("/users/me/time-zone/browser", { timeZone })).data);
  } catch (error) {
    handleApiError(error, "report browser time zone");
  }
}

export async function pinMyTimeZone(timeZone: string): Promise<MyTimeZone> {
  try {
    return wire((await authApi.put("/users/me/time-zone/pin", { timeZone })).data);
  } catch (error) {
    handleApiError(error, "pin time zone");
  }
}

export async function unpinMyTimeZone(browserTimeZone: string | null): Promise<MyTimeZone> {
  try {
    return wire(
      (await authApi.delete("/users/me/time-zone/pin", { data: { browserTimeZone } })).data,
    );
  } catch (error) {
    handleApiError(error, "unpin time zone");
  }
}
