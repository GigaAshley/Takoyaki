import axios from "axios";
import { authApi, handleApiError } from "@/main-axios";
import { afterMachineSettles, setOutcomeAsker } from "@/state/machine-changes-store";

// ─── Changes sent to a machine's front door ──────────────────────────────────
//
// A move or archive is carried out by the machine's front door, in the order
// requests reach it. Two things here keep that order the one the user clicked
// in, and give the caller the machine's real answer:
//
//   - inMachineOrder: one machine's changes are sent one after another, never
//     at once, so a later click can't overtake an earlier one on the way.
//   - sendMachineChange: sends one change with a request id chosen here (a
//     retry is the same request), and when the machine is still working on
//     it after the server's wait, asks again by that id until it has the
//     outcome or gives up (pending). Asking again is either the machine's
//     status for that id, or the same request sent again (when the route has
//     its own work to do once the change is done — an archive releases rooms).

/** A refusal or failure from the machine, with its reason as the message. */
export class MachineChangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly result: unknown,
  ) {
    super(message);
    this.name = "MachineChangeError";
  }
}

export type MachineChangeAnswer<T> =
  | { done: true; requestId: string; result: T }
  /** Still waiting or running when we stopped asking; the machine carries on with it. */
  | { done: false; requestId: string };

const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after every change already sent to this machine has been answered. */
export function inMachineOrder<T>(hostId: number | string, fn: () => Promise<T>): Promise<T> {
  const key = String(hostId);
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

export function newRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** How many more times to ask about a change still under way (each waits ~15s on the server). */
const FOLLOW_UPS = 3;
/** Pauses before asking again while the server can't be reached (about a minute in all). */
const AWAY_PAUSES_MS = [2_000, 4_000, 8_000, 15_000, 15_000, 15_000];

/** The server was updated since this page loaded: it turns the old page away (and the app
 *  asks the person to reload). */
function staleClient(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 409 && (error.response.data as Body | undefined)?.error === "stale_client";
}

/** No answer from the server itself: no response, or the proxy in front saying it's down. */
function serverAway(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (!error.response) return true;
  const status = error.response.status;
  const data = error.response.data as { code?: unknown } | undefined;
  return status === 502 || status === 504 || (status === 503 && !(data && typeof data === "object" && "code" in data));
}

type Body = { ok?: boolean; pending?: boolean; requestId?: string; result?: unknown; error?: string; code?: string };

function asError(error: unknown, operation: string): never {
  if (axios.isAxiosError(error) && error.response && error.response.status !== 401 && error.response.status !== 403) {
    const data = (error.response.data ?? {}) as Body;
    throw new MachineChangeError(
      typeof data.error === "string" && data.error ? data.error : `couldn't ${operation}`,
      error.response.status,
      typeof data.code === "string" ? data.code : null,
      data.result ?? null,
    );
  }
  handleApiError(error, operation);
}

/**
 * Send one change and wait for the machine's answer. `followUp` is how to ask
 * again while it's still under way: "status" (by id), "resend" (the same
 * request, same id) or "none". `onStillWorking` fires once, the first time
 * the machine says it's still on it.
 */
export async function sendMachineChange<T>(
  hostId: number,
  request: { method: "get" | "post" | "put"; url: string; body?: Record<string, unknown> },
  operation: string,
  opts: { followUp: "status" | "resend" | "none"; onStillWorking?: () => void },
): Promise<MachineChangeAnswer<T>> {
  const requestId = (request.body?.requestId as string | undefined) ?? newRequestId();
  let data: Body;
  try {
    const response =
      request.method === "get"
        ? await authApi.get(request.url)
        : await authApi[request.method](request.url, { ...request.body, requestId });
    data = response.data as Body;
    if (response.status !== 202) return { done: true, requestId: data.requestId ?? requestId, result: data as T };
  } catch (error) {
    // No answer from the server (the connection dropped, or it restarted mid-wait): the
    // change may well be under way on the machine, so ask about it by id rather than treat
    // it as failed. A read has nothing to ask about — it just failed.
    if (staleClient(error)) {
      // Turned away before it reached the machine: nothing happened.
      throw new MachineChangeError("the app was just updated — reload, then try again", 409, "stale_client", null);
    }
    if (!(serverAway(error) && request.method !== "get")) asError(error, operation);
    data = { requestId };
  }
  const id = data.requestId ?? requestId;
  opts.onStillWorking?.();
  if (opts.followUp === "none") return { done: false, requestId: id };
  let away = 0;
  for (let i = 0; i < FOLLOW_UPS; ) {
    try {
      const response =
        opts.followUp === "status" || request.method === "get"
          ? await authApi.get(`/machine-changes/${hostId}/${encodeURIComponent(id)}`)
          : await authApi[request.method](request.url, { ...request.body, requestId: id });
      if (response.status !== 202) return { done: true, requestId: id, result: response.data as T };
      i++;
    } catch (error) {
      // The server can't be reached (restarting, or the connection dropped): that says
      // nothing about the change, which the machine carries on with. Ask again after a
      // pause; past that, the machine's own status report settles it.
      // Updated since this page loaded: it can't ask any more (it's being asked to reload);
      // the machine carries on, and its report settles it after the reload.
      if (staleClient(error)) break;
      if (!serverAway(error)) asError(error, operation);
      if (away >= AWAY_PAUSES_MS.length) break;
      console.info({ operation: "machine_change_follow_up_server_away", hostId, requestId: id, attempt: away + 1 });
      await new Promise((r) => setTimeout(r, AWAY_PAUSES_MS[away++]));
    }
  }
  return { done: false, requestId: id };
}

/** A machine's reason as a sentence for a dialog: capitalised, with a full stop. */
export function reasonSentence(reason: string): string {
  const s = reason.trim();
  if (!s) return s;
  const first = s[0] === '"' ? s : s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/**
 * This person has had one of a machine's notices (a refusal, failure or stuck archive):
 * dismissed from a row, or claimed by this device before showing it as a pop-up. Resolves
 * true for the first claim — false when one of their devices already had it.
 * Key: the request id, or `<id>:stuck`.
 */
export async function markNoticeSeen(hostId: number | string, key: string): Promise<boolean> {
  try {
    const response = await authApi.post(
      `/machine-changes/${encodeURIComponent(String(hostId))}/${encodeURIComponent(key)}/seen`,
      {},
    );
    return (response.data as { first?: unknown }).first === true;
  } catch (error) {
    handleApiError(error, "dismiss the notice");
  }
}

/**
 * How a change sent from this device ended: at once when its answer came back done, or —
 * when the device stopped asking while it still waited its turn — once the machine's
 * status report says it's finished ("done") or that it didn't happen ("failed"; the
 * person is told on the row, with why). Whatever the device shows for the change stays
 * until then.
 */
export function whenMachineDone(
  hostId: number | string,
  answer: MachineChangeAnswer<unknown>,
): Promise<"done" | "failed"> {
  return !answer || answer.done ? Promise.resolve("done") : afterMachineSettles(hostId, answer.requestId);
}

/**
 * How a request ended, asked of its machine by id — quietly: a refusal read this way doesn't
 * count as having told the person (their row's mark does that).
 */
async function askOutcome(hostId: string, requestId: string): Promise<"done" | "failed" | "pending"> {
  try {
    const response = await authApi.get(
      `/machine-changes/${encodeURIComponent(hostId)}/${encodeURIComponent(requestId)}?quiet=1`,
    );
    return response.status === 202 ? "pending" : "done";
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const status = error.response.status;
      // Unknown to the machine (forgotten after a week): nothing left to hold.
      if (status === 404) return "done";
      if (status === 409 || status === 500) return "failed";
    }
    // No answer (offline, the machine unreachable): ask again on the next report.
    return "pending";
  }
}

setOutcomeAsker(askOutcome);
