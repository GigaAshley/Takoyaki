/**
 * file-save.ts — a whole file saved from an editor, at the machine's front door.
 *
 * Every editor that saves a whole file (the project file, the agent file, the role file,
 * the Files tabs) is handed the file's version when it opens it, and sends it back with
 * the save. The new contents wait in the front door's uploads folder; at the save's turn
 * the machine writes them only if the file is still that version. Otherwise nothing is
 * written and the answer says what the version is now, so the editor can offer to reload
 * or keep the user's edits (saving again with that version overwrites on purpose).
 *
 * A version is the file's sha256. A project file's is taken without its member list: the
 * machine keeps that list up to date itself, so it changing isn't a change, and a save
 * always keeps the machine's list. The same reckoning runs on the machine
 * (substrate/scripts/fleet-change, file_version) — the two must agree.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Client as SSHClientType } from "ssh2";
import { getLocalIdentitiesRoot, writeBinaryFileAtomic } from "../claude-session/identity-artifact-reader.js";
import { execCommand } from "../ssh/tmux-helper.js";
import { databaseLogger } from "../utils/logger.js";
import { requestIdFrom, submitFrontDoor } from "./front-door.js";

/** "There was no file" — what an editor sends for a file it's creating. */
export const ABSENT = "absent";
export const VERSION_RE = /^[0-9a-f]{64}$/;

export function isExpect(v: unknown): v is string {
  return v === ABSENT || (typeof v === "string" && VERSION_RE.test(v));
}

const FM_RE = /^(\uFEFF?---\r?\n)((?:[^\n]*\n)*?)(---(?:\r?\n|$))/;

/** (start, end) of a top-level frontmatter key with its continuation lines — the machine's key_span. */
function keySpan(lines: string[], key: string): [number, number] | null {
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (!keyRe.test(lines[i])) continue;
    let j = i + 1;
    for (;;) {
      if (j < lines.length && (/^[ \t]/.test(lines[j]) || /^-(\s|$)/.test(lines[j]))) {
        j++;
        continue;
      }
      let k = j;
      while (k < lines.length && lines[k].trim() === "") k++;
      if (k > j && k < lines.length && /^[ \t]/.test(lines[k])) {
        j = k;
        continue;
      }
      return [i, j];
    }
  }
  return null;
}

/** `text` with one top-level frontmatter key, and its continuation lines, taken out. */
export function withoutFrontmatterKey(text: string, key: string): string {
  const m = FM_RE.exec(text);
  if (!m) return text;
  const lines = m[2].match(/[^\n]*\n/g) ?? [];
  const span = keySpan(lines, key);
  if (span === null) return text;
  lines.splice(span[0], span[1] - span[0]);
  return m[1] + lines.join("") + m[3] + text.slice(m[0].length);
}

/** A file's version, as the machine reckons it. */
export function fileVersion(data: Buffer, keepMembers = false): string {
  let bytes = data;
  if (keepMembers) {
    const text = data.toString("utf8");
    // Only text that reads back to the same bytes (the machine hashes undecodable files as they are).
    if (Buffer.from(text, "utf8").equals(data)) bytes = Buffer.from(withoutFrontmatterKey(text, "members"), "utf8");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/** A path relative to the home folder that names a file, with nothing that could leave it. */
export function isHomePath(p: string): boolean {
  return p.length > 0 && p.length <= 4096 && !p.includes("\0") && p.split("/").every((x) => x !== "" && x !== "." && x !== "..");
}

function shellWord(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Read a file an editor is opening, with its version. The bytes come back exactly as they are
 * (a command's output would lose its last line end, and with it the version). `localPath`
 * is where this backend's own machine has it; "absent" when there's no file.
 */
export async function readForSave(
  conn: SSHClientType | null,
  opts: { homePath: string; localPath: string; keepMembers?: boolean },
): Promise<{ data: Buffer; text: string; version: string }> {
  if (!isHomePath(opts.homePath)) throw new Error("invalid path");
  let data: Buffer | null;
  if (conn === null) {
    try {
      data = await fs.readFile(opts.localPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      data = null;
    }
  } else {
    const f = `"$HOME"/${shellWord(opts.homePath)}`;
    const out = await execCommand(conn, `if [ -f ${f} ]; then printf F; base64 -w0 < ${f}; else printf N; fi`);
    if (out.startsWith("F")) data = Buffer.from(out.slice(1), "base64");
    else if (out === "N") data = null;
    else throw new Error("couldn't read the file");
  }
  if (data === null) return { data: Buffer.alloc(0), text: "", version: ABSENT };
  return { data, text: data.toString("utf8"), version: fileVersion(data, opts.keepMembers) };
}

export type SaveAnswer =
  | { ok: true; version: string; requestId: string }
  /** `version` (on changed / exists): the file's version now; null when there's no file. */
  | { ok: false; status: number; code: string; error: string; version?: string | null };

/** The words an editor shows when its file changed since it was opened. */
export const CHANGED_ERROR = "it changed since you opened it";

/**
 * Save `data` over `homePath` (relative to the home folder, e.g. `fleet/projects/x/project.md`)
 * at the front door, only if the file is still `expect`.
 */
export async function saveFileAtTurn(
  conn: SSHClientType | null,
  opts: {
    homePath: string;
    data: Buffer;
    expect: string;
    keepMembers?: boolean;
    /** A project's own file: a changed parent line gets a move's guard rails at its turn. */
    project?: { slug: string; asker?: string };
    hostId?: number;
    by?: string;
    requestId?: string;
    /** A machine that isn't part of the fleet (the admin's file browser on any SSH host) has
     *  no front door: there the same check is made just before the write instead. */
    withoutFrontDoor?: "check-then-write";
  },
): Promise<SaveAnswer> {
  if (!isExpect(opts.expect)) {
    return { ok: false, status: 400, code: "bad_request", error: "version must be the one the file was opened at" };
  }
  if (!isHomePath(opts.homePath)) return { ok: false, status: 400, code: "bad_request", error: "invalid path" };
  const id = requestIdFrom(opts.requestId);
  if (conn !== null && opts.withoutFrontDoor && !(await frontDoorInstalled(conn))) {
    return saveWithoutFrontDoor(conn, opts.homePath, opts.data, opts.expect, id);
  }
  const upload = `save-${id}`;
  const local = conn === null;
  const uploadsDir = path.join(path.dirname(getLocalIdentitiesRoot()), ".changes", "uploads");
  if (local) await fs.mkdir(uploadsDir, { recursive: true });
  else await execCommand(conn, `mkdir -p "$HOME/fleet/.changes/uploads"`);
  await writeBinaryFileAtomic(conn, `$HOME/fleet/.changes/uploads/${upload}`, opts.data);

  const outcome = await submitFrontDoor(
    conn,
    "file-save",
    {
      path: opts.homePath,
      upload,
      expect: opts.expect,
      ...(opts.keepMembers ? { keepMembers: true } : {}),
      ...(opts.project ? { project: opts.project } : {}),
    },
    { id, hostId: opts.hostId, by: opts.by },
  );
  databaseLogger.info("file saved at the front door", {
    operation: "file_save_request",
    hostId: opts.hostId,
    homePath: opts.homePath,
    bytes: opts.data.byteLength,
    expect: opts.expect === ABSENT ? ABSENT : "version",
    state: outcome.state,
    code: "code" in outcome ? outcome.code : undefined,
    requestId: id,
  });
  switch (outcome.state) {
    case "done": {
      const version = (outcome.result as { version?: unknown } | null)?.version;
      return { ok: true, version: typeof version === "string" ? version : "", requestId: id };
    }
    case "refused": {
      if (outcome.code === "changed" || outcome.code === "exists") {
        const v = (outcome.result as { version?: unknown } | undefined)?.version;
        return {
          ok: false,
          status: 409,
          code: outcome.code,
          error: outcome.reason,
          version: typeof v === "string" && VERSION_RE.test(v) ? v : null,
        };
      }
      return { ok: false, status: outcome.code === "bad_request" ? 400 : 409, code: outcome.code, error: outcome.reason };
    }
    case "failed":
      return { ok: false, status: 500, code: outcome.code, error: outcome.reason };
    case "pending":
      // The machine carries on with it; whatever the editor saves next is checked against what
      // landed, so nothing can be written over unseen.
      return {
        ok: false,
        status: 202,
        code: "pending",
        error: "the machine is still saving it — reopen the file before saving again",
      };
    case "not_installed":
      // The machine never took it: the staged copy isn't wanted.
      if (local) await fs.unlink(path.join(uploadsDir, upload)).catch(() => undefined);
      else await execCommand(conn, `rm -f "$HOME/fleet/.changes/uploads/${upload}"`).catch(() => undefined);
      return { ok: false, status: 503, code: "updating", error: "this machine is still updating, try again in a moment" };
  }
}

async function frontDoorInstalled(conn: SSHClientType): Promise<boolean> {
  return (await execCommand(conn, `[ -f "$HOME/.local/bin/fleet-change" ] && echo yes || echo no`)).trim() === "yes";
}

/** No front door on this machine (it isn't one of the fleet's): the version is checked on the
 *  machine just before the write — nothing else there takes turns to wait for. */
async function saveWithoutFrontDoor(
  conn: SSHClientType,
  homePath: string,
  data: Buffer,
  expect: string,
  requestId: string,
): Promise<SaveAnswer> {
  const f = `"$HOME"/${shellWord(homePath)}`;
  const out = await execCommand(conn, `if [ -f ${f} ]; then sha256sum < ${f}; else echo absent; fi`);
  const now = out.trim().split(/\s+/)[0] ?? "";
  if (now !== ABSENT && !VERSION_RE.test(now)) return { ok: false, status: 502, code: "unreadable", error: "couldn't read the file" };
  if (now === ABSENT && expect !== ABSENT) {
    return { ok: false, status: 409, code: "changed", error: "it was deleted or moved since you opened it", version: null };
  }
  if (now !== ABSENT && expect === ABSENT) {
    return { ok: false, status: 409, code: "exists", error: "there's already a file of that name", version: now };
  }
  if (now !== ABSENT && now !== expect) return { ok: false, status: 409, code: "changed", error: CHANGED_ERROR, version: now };
  await writeBinaryFileAtomic(conn, `$HOME/${homePath}`, data);
  databaseLogger.info("file saved without a front door", { operation: "file_save_direct", homePath, bytes: data.byteLength, requestId });
  return { ok: true, version: fileVersion(data), requestId };
}
