import axios from "axios";
import { authApi, handleApiError } from "@/main-axios";

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
  request: { method: "get" | "post"; url: string; body?: Record<string, unknown> },
  operation: string,
  opts: { followUp: "status" | "resend" | "none"; onStillWorking?: () => void },
): Promise<MachineChangeAnswer<T>> {
  const requestId = (request.body?.requestId as string | undefined) ?? newRequestId();
  let data: Body;
  try {
    const response =
      request.method === "get"
        ? await authApi.get(request.url)
        : await authApi.post(request.url, { ...request.body, requestId });
    data = response.data as Body;
    if (response.status !== 202) return { done: true, requestId: data.requestId ?? requestId, result: data as T };
  } catch (error) {
    // No answer at all (the connection dropped): the change may well be under way on the
    // machine, so ask about it by id rather than treat it as failed. A read has nothing to
    // ask about — it just failed.
    if (!(axios.isAxiosError(error) && !error.response && request.method === "post")) asError(error, operation);
    data = { requestId };
  }
  const id = data.requestId ?? requestId;
  opts.onStillWorking?.();
  if (opts.followUp === "none") return { done: false, requestId: id };
  for (let i = 0; i < FOLLOW_UPS; i++) {
    try {
      const response =
        opts.followUp === "status" || request.method === "get"
          ? await authApi.get(`/machine-changes/${hostId}/${encodeURIComponent(id)}`)
          : await authApi.post(request.url, { ...request.body, requestId: id });
      if (response.status !== 202) return { done: true, requestId: id, result: response.data as T };
    } catch (error) {
      asError(error, operation);
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
