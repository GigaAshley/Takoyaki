/**
 * agent-services/distribution.ts — the substrate rows that push each
 * service's skill and scripts to hosts, built from the service folders.
 *
 *   services/<name>/skill/<path>  →  ~/.claude/skills/<name>/<path>
 *   services/<name>/bin/<file>    →  ~/.local/bin/<file>
 *
 * The distributor sweeps these alongside its hand-kept catalog, so a new
 * service's skill and wrapper reach hosts without touching the catalog.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { BundledCatalogEntry } from "../distributor/catalog.js";
import { systemLogger } from "../utils/logger.js";
import { isHidden, type DiscoveredService } from "./registry.js";

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const entries = readdirSync(path.join(dir, rel), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      if (isHidden(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out;
}

export function serviceCatalogRows(
  services: readonly DiscoveredService[],
  log: (message: string, context: Record<string, unknown>) => void = (m, c) =>
    systemLogger.error(m, undefined, c),
): BundledCatalogEntry[] {
  const rows: BundledCatalogEntry[] = [];
  for (const svc of services) {
    try {
      rows.push(...rowsFor(svc));
    } catch (err) {
      // Discovery already checked the folder; this only catches it changing
      // under us. Leave this service's files out, never the whole catalog.
      log(`agent-services: ${svc.def.name} skill and scripts not distributed`, {
        operation: "agent_services_rows_failed",
        service: svc.def.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows;
}

function rowsFor({ def, dir }: DiscoveredService): BundledCatalogEntry[] {
  const rows: BundledCatalogEntry[] = [];
  const skillDir = path.join(dir, "skill");
  if (existsSync(skillDir)) {
    const files = filesUnder(skillDir);
    // SKILL.md first, then its companions.
    files.sort((a, b) => Number(b === "SKILL.md") - Number(a === "SKILL.md"));
    for (const rel of files) {
      rows.push({
        slug:
          rel === "SKILL.md"
            ? `${def.name}-skill`
            : `${def.name}-skill-${rel.replace(/[^A-Za-z0-9]+/g, "-")}`,
        sourceKind: "bundled",
        bundledPath: path.join(skillDir, rel),
        installPath: `~/.claude/skills/${def.name}/${rel}`,
        restartHook: null,
      });
    }
  }
  const binDir = path.join(dir, "bin");
  if (existsSync(binDir)) {
    for (const file of filesUnder(binDir)) {
      rows.push({
        slug: `${file}-helper`,
        sourceKind: "bundled",
        bundledPath: path.join(binDir, file),
        installPath: `~/.local/bin/${file}`,
        restartHook: null,
      });
    }
  }
  return rows;
}
