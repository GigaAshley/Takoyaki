import axios from "axios";
import { authApi, handleApiError } from "@/main-axios";
import { inMachineOrder, newRequestId } from "@/api/machine-changes-api";

// ─── Phase 143 Plan 143-05 (D-03 / D-17) — unarchiveIdentity ────────────────
//
// One-shot POST that drops the `.unarchive-requested` sentinel inside the
// identity's ARCHIVE folder. The backend route (143-04) handles the sentinel
// drop + precondition checks; this frontend helper is a thin fetch wrapper
// paralleling `identity-archive-api.ts`.
//
// Endpoint:  POST /identities/:key/unarchive
// Body:      { hostId: number }
// Response:  { ok: true, outcome: "restored" | "pending" }
//
// The backend drops the flag and then waits up to 2 minutes for the
// supervisor's outcome, so this call uses a longer timeout than authApi's
// default. "pending" = no outcome yet; the un-archive keeps going.
//
// Structured 409 failure reasons (D-03):
//   missing_roles     — identity depends on still-archived roles; missingRoles
//                       carries the names so the surface can name them in the
//                       alert (D-17).
//   name_collision    — a live-tree identity with the same key already exists.
//   archive_not_found — the archived folder for this key doesn't exist.
//   refused           — the supervisor refused; `message` carries its reason.
//
// connection_lost (client-side, not a 409): the connection dropped while the
// backend was waiting — typically a phone suspending the app. The request may
// already have reached the server, so this isn't reported as a refusal.
//
// Non-409 errors flow through handleApiError (main-axios.ts) so callers see
// the same ApiError / message shape the rest of the codebase produces.
//
// UnarchiveError + UnarchiveFailureReason are defined ONCE here and re-imported
// by the sibling role-unarchive-api.ts + apps-unarchive-api.ts (single source
// of truth — never redefine them there).

// ─── Typed reason union ──────────────────────────────────────────────────────

export type UnarchiveFailureReason =
  | "missing_roles"
  | "name_collision"
  | "archive_not_found"
  | "refused"
  | "connection_lost"
  | "unknown";

export class UnarchiveError extends Error {
  constructor(
    message: string,
    public readonly reason: UnarchiveFailureReason,
    public readonly missingRoles?: string[],
  ) {
    super(message);
    this.name = "UnarchiveError";
  }
}

// ─── Internal 409 body shape ─────────────────────────────────────────────────

interface Unarchive409Body {
  reason?: string;
  missingRoles?: string[];
  message?: string;
}

// ─── Shared 409 parser ───────────────────────────────────────────────────────
//
// Parses a raw error from authApi.post. If the HTTP status is 409 and the
// response body carries a `reason` field, throws an UnarchiveError. Otherwise
// rethrows the error unchanged so the caller can pass it to handleApiError.

export function parseUnarchive409OrRethrow(error: unknown): never {
  if (axios.isAxiosError(error) && error.response?.status === 409) {
    const body = error.response.data as Unarchive409Body;
    const reason = body?.reason;

    if (reason === "missing_roles") {
      throw new UnarchiveError(
        `Un-archive blocked: missing roles — ${(body.missingRoles ?? []).join(", ")}`,
        "missing_roles",
        body.missingRoles ?? [],
      );
    }
    if (reason === "name_collision") {
      throw new UnarchiveError(
        "Un-archive blocked: a live object with the same name already exists.",
        "name_collision",
        undefined,
      );
    }
    if (reason === "archive_not_found") {
      throw new UnarchiveError(
        "Un-archive blocked: archive folder not found.",
        "archive_not_found",
        undefined,
      );
    }
    if (reason === "refused" || reason === "identity_unreadable") {
      throw new UnarchiveError(
        body.message || "the un-archive was refused",
        "refused",
        undefined,
      );
    }
    // Unknown 409 reason — surface it as UnarchiveError with "unknown" reason
    // so callers always receive a typed error for 409s, regardless of reason.
    throw new UnarchiveError(
      `Un-archive blocked: ${reason ?? "unknown reason"}.`,
      "unknown",
      undefined,
    );
  }
  // Non-409 — rethrow for the caller to pass to handleApiError.
  throw error;
}

// ─── unarchiveIdentity ────────────────────────────────────────────────────────

/** When a click that's still waiting is told "still working on it" (the server's usual wait). */
const STILL_WORKING_MS = 15_000;
/** How long one un-archive request may take on the server. */
const UNARCHIVE_REQUEST_TIMEOUT_MS = 60_000;
/** How long an agent un-archive is followed up after the machine accepted it. */
const AGENT_UNARCHIVE_FOLLOW_MS = 2 * 60 * 1000;

export type UnarchiveOutcome = "restored" | "pending";

/**
 * Send one un-archive (agent, role or app) to its machine, in the order this
 * machine's changes were clicked, and read the answer: restored, still
 * pending, or an UnarchiveError (a refusal with its reason, or the connection
 * dropping — the server may already have acted).
 */
export function sendUnarchive(
  hostId: number,
  url: string,
  body: Record<string, unknown>,
  operation: string,
  requestId: string = newRequestId(),
  onStillWorking?: () => void,
): Promise<{ ok: true; outcome: UnarchiveOutcome }> {
  return inMachineOrder(hostId, async () => {
    // "Still working on it" once the machine has taken longer than its usual answer.
    const still = onStillWorking ? setTimeout(onStillWorking, STILL_WORKING_MS) : undefined;
    try {
      const response = await authApi.post(url, { ...body, requestId }, { timeout: UNARCHIVE_REQUEST_TIMEOUT_MS });
      const data = response.data as { ok: true; outcome?: UnarchiveOutcome };
      return { ok: true as const, outcome: data.outcome === "pending" ? ("pending" as const) : ("restored" as const) };
    } catch (error) {
      if (axios.isAxiosError(error) && !error.response) {
        throw new UnarchiveError(
          `connection lost during un-archive (${error.code ?? "no response"})`,
          "connection_lost",
        );
      }
      try {
        parseUnarchive409OrRethrow(error);
      } catch (typed) {
        if (typed instanceof UnarchiveError) throw typed;
        handleApiError(typed, operation);
      }
    } finally {
      clearTimeout(still);
    }
  });
}

/**
 * Un-archive an agent. The machine accepts it in click order; bringing the
 * chat account and folder back takes a minute or so, followed up here by the
 * request's id — outside the machine's click order, so it holds nothing else
 * up. Resolves restored, or pending if it still isn't back after two minutes.
 */
export async function unarchiveIdentity(
  hostId: number,
  identityKey: string,
  onStillWorking?: () => void,
): Promise<{ ok: true; outcome: UnarchiveOutcome }> {
  const requestId = newRequestId();
  let told = false;
  const tell = () => {
    if (told) return;
    told = true;
    onStillWorking?.();
  };
  const first = await sendUnarchive(
    hostId,
    `/identities/${encodeURIComponent(identityKey)}/unarchive`,
    { hostId },
    "un-archive identity",
    requestId,
    tell,
  );
  if (first.outcome === "restored") return first;
  tell();
  const deadline = Date.now() + AGENT_UNARCHIVE_FOLLOW_MS;
  while (Date.now() < deadline) {
    let status: number;
    let data: { code?: string; error?: string; result?: { missingRoles?: string[] } };
    try {
      const response = await authApi.get(`/machine-changes/${hostId}/${encodeURIComponent(requestId)}`, {
        timeout: UNARCHIVE_REQUEST_TIMEOUT_MS,
      });
      status = response.status;
      data = response.data as typeof data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response && error.response.status !== 401 && error.response.status !== 403) {
        status = error.response.status;
        data = (error.response.data ?? {}) as typeof data;
      } else if (axios.isAxiosError(error) && !error.response) {
        await new Promise((r) => setTimeout(r, 2000)); // a dropped follow-up: ask again shortly
        continue;
      } else {
        handleApiError(error, "un-archive identity");
      }
    }
    if (status === 200) return { ok: true, outcome: "restored" };
    if (status === 202) continue;
    if (status === 409) {
      const code = data.code ?? "";
      const missing = data.result?.missingRoles;
      throw new UnarchiveError(
        data.error || "the un-archive was refused",
        code === "missing_roles" || code === "name_collision" || code === "archive_not_found" ? code : "refused",
        Array.isArray(missing) ? missing : undefined,
      );
    }
    throw new UnarchiveError(data.error || "the un-archive failed", "unknown");
  }
  return { ok: true, outcome: "pending" };
}
