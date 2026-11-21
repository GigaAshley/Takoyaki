// matrix-room-actions-client — the Matrix calls behind a relay room's Leave
// and Rename… menu items, plus the room-state read the sidebar's stacked
// faces use.
//
// Same scaffolding as matrix-admin-client: Node fetch + AbortController
// timeout, encodeURIComponent on every path arg, a discriminated-union
// result, and never logging a token or a request body.
//
// Acting-as rules:
//   - Leave and the name change are sent with the USER's own token
//     (ensureUserToken), so the room shows the user leaving / renaming.
//   - The rights grant is sent with a short-lived token for the AGENT that
//     controls the room, so the room shows that agent granting the user.
//   - The room-state read uses the admin token against the admin API, which
//     works whether or not the admin account is in the room.

import { databaseLogger } from "../utils/logger.js";
import { getMatrixAdminCreds } from "./matrix-admin-creds-store.js";
import {
  ensureUserToken,
  loginAsUser,
  ONE_CALL_TOKEN_TTL_MS,
  evictUserToken,
} from "./matrix-admin-client.js";

const REQUEST_TIMEOUT_MS = 30_000;

const ERR_CREDS_MISSING = "matrix_admin_creds_missing";
const ERR_NON_2XX = "matrix_room_action_non_2xx";
const ERR_TIMEOUT = "matrix_room_action_timeout";
const ERR_PROXY = "matrix_room_action_proxy_error";
const ERR_MALFORMED = "matrix_room_action_malformed_response";

export type RoomActionErr = { ok: false; status: number; error: string };

/** One state event as the admin room-state API returns it. */
export interface RoomStateEvent {
  type: string;
  state_key?: string;
  sender?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
}

async function timedFetch(
  url: string,
  init: { method: string; token: string; body?: unknown },
  operation: string,
): Promise<{ ok: true; response: Response } | RoomActionErr> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        "Content-Type": "application/json",
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return { ok: true, response };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, status: 504, error: ERR_TIMEOUT };
    }
    databaseLogger.error("matrix room action proxy error", err, { operation });
    return { ok: false, status: 502, error: ERR_PROXY };
  }
}

/**
 * Run a client-server call as `mxid` with the cached per-user token,
 * retrying once with a fresh token on 401 (same rule as sendMessageAsUser).
 */
async function asUser(
  mxid: string,
  build: (base: string) => { url: string; method: string; body?: unknown },
  operation: string,
): Promise<{ ok: true; status: number } | RoomActionErr> {
  const creds = await getMatrixAdminCreds();
  if (!creds) return { ok: false, status: 500, error: ERR_CREDS_MISSING };
  const req = build(creds.homeserverBase);
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await ensureUserToken(mxid);
    if (tok.ok === false) return tok;
    const res = await timedFetch(
      req.url,
      { method: req.method, token: tok.token, body: req.body },
      operation,
    );
    if (res.ok === false) return res;
    if (res.response.status === 401 && attempt === 0) {
      evictUserToken(mxid);
      continue;
    }
    if (!res.response.ok) {
      return { ok: false, status: res.response.status, error: ERR_NON_2XX };
    }
    return { ok: true, status: res.response.status };
  }
  return { ok: false, status: 401, error: ERR_NON_2XX };
}

/** POST /_matrix/client/v3/rooms/{roomId}/leave as the user. */
export async function leaveRoomAsUser(
  mxid: string,
  roomId: string,
): Promise<{ ok: true } | RoomActionErr> {
  const r = await asUser(
    mxid,
    (base) => ({
      url: `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
      method: "POST",
      body: {},
    }),
    "matrix_room_leave_as_user",
  );
  return r.ok ? { ok: true } : r;
}

/** PUT the room's m.room.name state event as the user. */
export async function setRoomNameAsUser(
  mxid: string,
  roomId: string,
  name: string,
): Promise<{ ok: true } | RoomActionErr> {
  const r = await asUser(
    mxid,
    (base) => ({
      url: `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
      method: "PUT",
      body: { name },
    }),
    "matrix_room_set_name_as_user",
  );
  return r.ok ? { ok: true } : r;
}

/**
 * PUT the room's m.room.power_levels as `granterMxid`, using a token minted
 * for this one call (an agent's token is never cached here).
 */
export async function putPowerLevelsAs(
  granterMxid: string,
  roomId: string,
  content: Record<string, unknown>,
): Promise<{ ok: true } | RoomActionErr> {
  const creds = await getMatrixAdminCreds();
  if (!creds) return { ok: false, status: 500, error: ERR_CREDS_MISSING };
  const login = await loginAsUser(granterMxid, Date.now() + ONE_CALL_TOKEN_TTL_MS);
  if (login.ok === false) return login;
  const res = await timedFetch(
    `${creds.homeserverBase}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
    { method: "PUT", token: login.accessToken, body: content },
    "matrix_room_put_power_levels_as",
  );
  if (res.ok === false) return res;
  if (!res.response.ok) {
    return { ok: false, status: res.response.status, error: ERR_NON_2XX };
  }
  return { ok: true };
}

/** GET /_synapse/admin/v1/rooms/{roomId}/state — the room's current state. */
export async function getRoomStateAdmin(
  roomId: string,
): Promise<{ ok: true; events: RoomStateEvent[] } | RoomActionErr> {
  const creds = await getMatrixAdminCreds();
  if (!creds) return { ok: false, status: 500, error: ERR_CREDS_MISSING };
  const res = await timedFetch(
    `${creds.homeserverBase}/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`,
    { method: "GET", token: creds.accessToken },
    "matrix_room_get_state_admin",
  );
  if (res.ok === false) return res;
  if (!res.response.ok) {
    return { ok: false, status: res.response.status, error: ERR_NON_2XX };
  }
  try {
    const parsed = (await res.response.json()) as { state?: unknown };
    if (!Array.isArray(parsed.state)) {
      return { ok: false, status: 502, error: ERR_MALFORMED };
    }
    const events = parsed.state.filter(
      (e): e is RoomStateEvent =>
        e !== null && typeof e === "object" && typeof (e as { type?: unknown }).type === "string",
    );
    return { ok: true, events };
  } catch {
    return { ok: false, status: 502, error: ERR_MALFORMED };
  }
}
