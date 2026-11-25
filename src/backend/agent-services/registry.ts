/**
 * agent-services/registry.ts — every agent service this backend offers,
 * found by reading the service folders.
 *
 * A service is one folder under `services/<name>/`:
 *   service.ts      default-exports `defineService({ name: "<name>", ... })`
 *   skill/          optional; installed to ~/.claude/skills/<name>/ on hosts
 *   bin/            optional; each file installed to ~/.local/bin/<file>
 * Nothing else in the app names a service. See README.md.
 *
 * A broken folder is skipped with a loud log line; the other services still
 * start. The registry test fails on any broken folder in this repo, so one
 * should never ship.
 *
 * Loaded with a top-level await, so a service module must never import this
 * file (or anything that does, like distributor/full-catalog.ts): the
 * circular import would see the lists before they are filled.
 */

import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { systemLogger } from "../utils/logger.js";
import type { ServiceDefinition } from "./engine/types.js";

export interface DiscoveredService {
  def: ServiceDefinition;
  /** Absolute path of the service's folder. */
  dir: string;
}

export interface SkippedService {
  folder: string;
  reason: string;
}

export interface Discovery {
  services: DiscoveredService[];
  skipped: SkippedService[];
}

export const SERVICES_DIR = fileURLToPath(new URL("./services/", import.meta.url));

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Why a service definition can't be used, or null when it can. */
function definitionProblem(def: unknown, folder: string): string | null {
  if (!def || typeof def !== "object") {
    return "service file has no default export from defineService()";
  }
  const d = def as Partial<ServiceDefinition>;
  if (d.name !== folder) {
    return `service is named "${String(d.name)}" but its folder is "${folder}"`;
  }
  if (typeof d.description !== "string" || d.description.length === 0) {
    return "service has no description";
  }
  if (!d.input || typeof (d.input as { safeParse?: unknown }).safeParse !== "function") {
    return "service has no input schema";
  }
  if (typeof d.handle !== "function") return "service has no handle()";
  if (typeof d.ttlMs !== "number" || !(d.ttlMs > 0)) {
    return "service has no positive ttlMs";
  }
  if (d.secrets !== undefined) {
    if (typeof d.secrets !== "object" || d.secrets === null || Array.isArray(d.secrets)) {
      return "secrets must map each key name to a label and a description";
    }
    for (const [key, spec] of Object.entries(d.secrets)) {
      if (!KEY_NAME_RE.test(key)) return `key name "${key}" is not UPPER_SNAKE`;
      if (
        !spec ||
        typeof spec.label !== "string" ||
        spec.label.length === 0 ||
        typeof spec.description !== "string" ||
        spec.description.length === 0
      ) {
        return `key ${key} needs a label and a description`;
      }
    }
  }
  return null;
}

/** Hidden files (e.g. .DS_Store) in skill/ and bin/ are never shipped. */
export const isHidden = (name: string) => name.startsWith(".");

/**
 * Why a skill/ or bin/ tree can't be shipped, or null. Everything in it
 * must be a plain file or folder: a symlink would be skipped by the push, so
 * it is refused here instead.
 */
function treeProblem(root: string, label: string): string | null {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (isHidden(e.name)) continue;
    const rel = `${label}/${e.name}`;
    if (e.isSymbolicLink()) return `${rel} is a symlink`;
    if (e.isDirectory()) {
      const inner = treeProblem(path.join(root, e.name), rel);
      if (inner) return inner;
    } else if (!e.isFile()) {
      return `${rel} is not a file`;
    }
  }
  return null;
}

/** Why a service's skill/ and bin/ folders can't be shipped, or null. */
function assetProblem(dir: string): string | null {
  for (const sub of ["skill", "bin"]) {
    const p = path.join(dir, sub);
    const st = lstatSafe(p);
    if (!st) continue;
    if (!st.isDirectory()) return `${sub} is not a folder`;
    const problem = treeProblem(p, sub);
    if (problem) return problem;
  }
  const skillDir = path.join(dir, "skill");
  if (existsSync(skillDir) && !existsSync(path.join(skillDir, "SKILL.md"))) {
    return "skill/ has no SKILL.md";
  }
  const binDir = path.join(dir, "bin");
  if (existsSync(binDir)) {
    for (const e of readdirSync(binDir, { withFileTypes: true })) {
      if (isHidden(e.name)) continue;
      if (!e.isFile()) return `bin/${e.name} is not a file`;
      if ((statSync(path.join(binDir, e.name)).mode & 0o111) === 0) {
        return `bin/${e.name} is not executable`;
      }
    }
  }
  return null;
}

/** lstat that returns null instead of throwing (e.g. for a dangling link). */
function lstatSafe(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function serviceModulePath(dir: string): string | null {
  // Compiled builds hold service.js; tests and dev run service.ts.
  for (const file of ["service.js", "service.ts"]) {
    const p = path.join(dir, file);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Load every service folder under `root`, in folder-name order. Broken
 * folders are left out and reported in `skipped` (and logged loudly).
 */
export async function discoverServices(
  root: string = SERVICES_DIR,
  log: (message: string, context: Record<string, unknown>) => void = (m, c) =>
    systemLogger.error(m, undefined, c),
): Promise<Discovery> {
  const services: DiscoveredService[] = [];
  const skipped: SkippedService[] = [];
  const skip = (folder: string, reason: string) => {
    skipped.push({ folder, reason });
    log(`agent-services: service "${folder}" skipped: ${reason}`, {
      operation: "agent_services_service_skipped",
      service: folder,
      reason,
    });
  };

  const folders = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const folder of folders) {
    const dir = path.join(root, folder);
    if (!NAME_RE.test(folder)) {
      skip(folder, "folder name must be kebab-case");
      continue;
    }
    const modulePath = serviceModulePath(dir);
    if (!modulePath) {
      skip(folder, "no service.ts in the folder");
      continue;
    }
    let def: unknown;
    try {
      def = ((await import(pathToFileURL(modulePath).href)) as { default?: unknown })
        .default;
    } catch (err) {
      skip(folder, `service file failed to load: ${errText(err)}`);
      continue;
    }
    let problem: string | null;
    try {
      problem = definitionProblem(def, folder) ?? assetProblem(dir);
    } catch (err) {
      // Unreadable folder, a file vanishing mid-read, …: still just this one.
      problem = `folder could not be read: ${errText(err)}`;
    }
    if (problem) {
      skip(folder, problem);
      continue;
    }
    services.push({ def: def as ServiceDefinition, dir });
  }
  return { services, skipped };
}

export const DISCOVERED_SERVICES: readonly DiscoveredService[] = (
  await discoverServices()
).services;

export const AGENT_SERVICES: readonly ServiceDefinition[] = DISCOVERED_SERVICES.map(
  (s) => s.def,
);
