/**
 * agent-services/http/routes.ts — where machines send service requests.
 * Mounted at /agent-services in database.ts; the wire format is in
 * engine/protocol.ts.
 *
 *   POST   /v1/jobs/:id            start (or rejoin) a request, wait for it
 *   GET    /v1/jobs/:id            wait for a request already started
 *   GET    /v1/jobs/:id/files/:i   one of its output files
 *   DELETE /v1/jobs/:id            the caller has the answer; drop it
 *
 * Every call carries the machine's credential (`Authorization: Bearer …`,
 * machine-credentials/store.ts). That says which machine is asking and
 * nothing more; these routes only run service requests. Waits hold the
 * connection up to HOLD_MS (or `?wait=<seconds>`, less): 200 with the answer
 * when it's ready, 202 `{state:"running"}` when it isn't yet. An ID this
 * process doesn't know is 404 `lost`: it was lost in a restart or expired,
 * and is never run again on the caller's behalf.
 */

import express, { type Request, type Response, type NextFunction, type Router } from "express";
import multer from "multer";
import { systemLogger } from "../../utils/logger.js";
import type { AgentServiceEngine, RequestHost } from "../engine/engine.js";
import type { JobStore } from "../engine/jobs.js";
import type { ServiceDefinition } from "../engine/types.js";
import {
  ATTACHMENT_FIELD_PREFIX,
  SLOT_NAME_RE,
  UUID_RE,
  attachmentExt,
  parseEnvelope,
  type IncomingRequest,
} from "../engine/protocol.js";
import type { MachineIdentity } from "../machine-credentials/store.js";

/** Longest a single call waits before answering "still running". */
export const HOLD_MS = 50_000;
const MAX_ATTACHMENTS = 8;
const MAX_REQUEST_JSON_BYTES = 4 * 1024 * 1024;

export interface ServiceRuntime {
  engine: AgentServiceEngine;
  jobs: JobStore;
  /** The services and core handlers, for their attachment slots. */
  services: readonly ServiceDefinition[];
}

export interface AgentServicesRouterDeps {
  /** Null until the services have started. */
  runtime(): ServiceRuntime | null;
  identifyMachine(token: string): Promise<MachineIdentity>;
  /** The host row a machine's requests are run as, or null if it no longer runs agents. */
  hostForMachine(machineId: string): Promise<RequestHost | null>;
}

/** The largest file a service takes in an attachment slot, or null when it has no such slot. */
function attachmentLimit(rt: ServiceRuntime, service: string, slot: string): number | null {
  const def = rt.services.find((s) => s.name === service);
  const spec = def && Object.hasOwn(def.attachments ?? {}, slot) ? def.attachments![slot] : undefined;
  return spec ? spec.maxBytes : null;
}

/** The largest attachment any service takes: the upload limit per file. */
function maxAttachmentBytes(rt: ServiceRuntime): number {
  return Math.max(1, ...rt.services.flatMap((s) => Object.values(s.attachments ?? {}).map((a) => a.maxBytes)));
}

type Authed = Request & { serviceHost?: RequestHost };

class RejectedUpload extends Error {}

/** The service named in a request field, or null if it can't be read yet. */
function serviceOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const service = (JSON.parse(raw) as { service?: unknown }).service;
    return typeof service === "string" ? service : null;
  } catch {
    return null;
  }
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ ok: false, service: null, error: { code, message } });
}

/** `?wait=<seconds>` clamped to [0, HOLD_MS]; HOLD_MS when absent. */
function holdMsFrom(req: Request): number {
  const raw = typeof req.query.wait === "string" ? Number(req.query.wait) : NaN;
  if (!Number.isFinite(raw)) return HOLD_MS;
  return Math.max(0, Math.min(HOLD_MS, Math.round(raw * 1000)));
}

export function createAgentServicesRouter(deps: AgentServicesRouterDeps): Router {
  const router = express.Router();
  /**
   * Multipart parsing for one request. Files are refused while they arrive,
   * before they're held in memory, unless the request's service has their
   * slot; none can exceed the largest attachment any service takes (the
   * engine then checks the slot's own limit).
   */
  function uploadFor(rt: ServiceRuntime) {
    const fileFilter: multer.Options["fileFilter"] = (req, file, accept) => {
      const service = serviceOf((req.body as Record<string, unknown> | undefined)?.request);
      const slot = file.fieldname.startsWith(ATTACHMENT_FIELD_PREFIX)
        ? file.fieldname.slice(ATTACHMENT_FIELD_PREFIX.length)
        : "";
      if (service === null) {
        accept(new RejectedUpload("the request field must come before any attachment"));
      } else if (attachmentLimit(rt, service, slot) === null) {
        accept(new RejectedUpload(`unexpected attachment: ${slot || file.fieldname}`));
      } else {
        accept(null, true);
      }
    };
    return multer({
      storage: multer.memoryStorage(),
      fileFilter,
      limits: {
        fileSize: maxAttachmentBytes(rt),
        files: MAX_ATTACHMENTS,
        fieldSize: MAX_REQUEST_JSON_BYTES,
        fields: 4,
      },
    });
  }

  async function authenticate(req: Authed, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      refuse(res, 401, "unauthorized", "no machine credential was sent");
      return;
    }
    try {
      const who = await deps.identifyMachine(token);
      if (who.ok === false) {
        systemLogger.warn("agent-services: request refused at the door", {
          operation: "agent_services_auth_refused",
          reason: who.reason,
          path: req.path,
        });
        if (who.reason === "revoked") {
          refuse(
            res,
            403,
            "revoked",
            "an admin revoked this machine's access to services; an admin can issue it a new credential in Admin → Services",
          );
        } else {
          refuse(
            res,
            401,
            "unauthorized",
            "this machine's service credential isn't one the backend issued (it may have been replaced; a fresh one arrives within a minute)",
          );
        }
        return;
      }
      const host = await deps.hostForMachine(who.machineId);
      if (!host) {
        refuse(res, 403, "unauthorized", "this machine no longer runs agents for this app");
        return;
      }
      req.serviceHost = host;
      next();
    } catch (err) {
      systemLogger.error("agent-services: credential check failed", {
        operation: "agent_services_auth_error",
        error: err instanceof Error ? err.message : String(err),
      });
      refuse(res, 500, "internal", "the backend couldn't check this machine's credential");
    }
  }

  function needRuntime(res: Response): ServiceRuntime | null {
    const rt = deps.runtime();
    if (!rt) refuse(res, 503, "starting", "the backend's services are still starting; try again shortly");
    return rt;
  }

  function idParam(req: Request, res: Response): string | null {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      refuse(res, 400, "malformed", "the request ID must be a UUID");
      return null;
    }
    return id.toLowerCase();
  }

  async function answerOrRunning(
    res: Response,
    rt: ServiceRuntime,
    host: RequestHost,
    id: string,
    holdMs: number,
  ): Promise<void> {
    const w = await rt.jobs.wait(host.machineId, id, holdMs);
    if (w.state === "done") res.status(200).json(w.answer.body);
    else if (w.state === "running") res.status(202).json({ state: "running" });
    else
      refuse(
        res,
        404,
        "lost",
        "the backend has no record of this request: it was lost when the backend restarted, or its answer expired. It was not run again",
      );
  }

  router.use("/v1", authenticate);

  router.post("/v1/jobs/:id", (req: Authed, res: Response) => {
    const id = idParam(req, res);
    if (!id) return;
    const rt = needRuntime(res);
    if (!rt) return;
    uploadFor(rt).any()(req, res, async (uploadErr: unknown) => {
      const host = req.serviceHost!;
      if (uploadErr) {
        const message =
          uploadErr instanceof multer.MulterError && uploadErr.code === "LIMIT_FILE_SIZE"
            ? `an attachment is over ${maxAttachmentBytes(rt)} bytes`
            : uploadErr instanceof RejectedUpload
              ? uploadErr.message
              : `couldn't read the request: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`;
        refuse(res, 400, "malformed", message);
        return;
      }

      const parsed = parseEnvelope(typeof req.body?.request === "string" ? req.body.request : "");
      if (parsed.ok === false) {
        res.status(200).json({
          ok: false,
          service: parsed.service ?? null,
          error: { code: "malformed", message: parsed.message },
        });
        return;
      }
      const attachments: IncomingRequest["attachments"] = {};
      for (const f of (req.files as Express.Multer.File[] | undefined) ?? []) {
        const slot = f.fieldname.startsWith(ATTACHMENT_FIELD_PREFIX)
          ? f.fieldname.slice(ATTACHMENT_FIELD_PREFIX.length)
          : "";
        const ext = attachmentExt(f.originalname);
        if (!SLOT_NAME_RE.test(slot) || attachments[slot]) {
          refuse(res, 400, "malformed", `bad attachment field: ${f.fieldname}`);
          return;
        }
        if (!ext) {
          refuse(res, 400, "malformed", `attachment ${slot} needs a file extension`);
          return;
        }
        attachments[slot] = { ext, bytes: f.buffer };
      }
      const request: IncomingRequest = {
        id,
        service: parsed.envelope.service,
        input: parsed.envelope.input,
        ...(parsed.envelope.as_user !== undefined ? { asUser: parsed.envelope.as_user } : {}),
        attachments,
      };
      const { joined } = rt.jobs.start(host.machineId, id, () => rt.engine.submit(host, request));
      systemLogger.info("agent-services: request received", {
        operation: "agent_services_received",
        requestId: id,
        service: request.service,
        machineId: host.machineId,
        fleetHostId: host.id,
        joined,
        attachments: Object.keys(attachments).length,
      });
      await answerOrRunning(res, rt, host, id, holdMsFrom(req));
    });
  });

  router.get("/v1/jobs/:id", async (req: Authed, res: Response) => {
    const id = idParam(req, res);
    if (!id) return;
    const rt = needRuntime(res);
    if (!rt) return;
    await answerOrRunning(res, rt, req.serviceHost!, id, holdMsFrom(req));
  });

  router.get("/v1/jobs/:id/files/:index", (req: Authed, res: Response) => {
    const id = idParam(req, res);
    if (!id) return;
    const rt = needRuntime(res);
    if (!rt) return;
    const answer = rt.jobs.answerOf(req.serviceHost!.machineId, id);
    const index = Number(req.params.index);
    const file = Number.isInteger(index) && index >= 0 ? answer?.files[index] : undefined;
    if (!file) {
      refuse(res, 404, "lost", "no such output file: the answer was already collected, expired, or lost in a restart");
      return;
    }
    res.status(200).type("application/octet-stream").send(file.bytes);
  });

  router.delete("/v1/jobs/:id", (req: Authed, res: Response) => {
    const id = idParam(req, res);
    if (!id) return;
    const rt = needRuntime(res);
    if (!rt) return;
    rt.jobs.forget(req.serviceHost!.machineId, id);
    res.status(204).end();
  });

  router.use((_req: Request, res: Response) => refuse(res, 404, "not_found", "no such service route"));

  return router;
}
