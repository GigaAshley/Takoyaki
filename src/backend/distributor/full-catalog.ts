/**
 * full-catalog.ts — everything the distributor pushes to hosts: the
 * hand-kept catalog plus each agent service's skill and scripts, read from
 * the service folders (agent-services/distribution.ts).
 *
 * A service row whose install path the hand-kept catalog (or an earlier
 * service) already uses is dropped with a loud log line, so a badly named
 * service can never overwrite a fleet file.
 */

import { systemLogger } from "../utils/logger.js";
import { DISCOVERED_SERVICES } from "../agent-services/registry.js";
import { serviceCatalogRows } from "../agent-services/distribution.js";
import {
  FLEET_SUBSTRATE_CATALOG,
  type BundledCatalogEntry,
  type CatalogEntry,
} from "./catalog.js";

export function combineCatalog(
  base: readonly CatalogEntry[],
  serviceRows: readonly BundledCatalogEntry[],
  log: (message: string, context: Record<string, unknown>) => void = (m, c) =>
    systemLogger.error(m, undefined, c),
): CatalogEntry[] {
  const taken = new Set(base.map((row) => row.installPath));
  const out: CatalogEntry[] = [...base];
  for (const row of serviceRows) {
    if (taken.has(row.installPath)) {
      log(`agent-services: ${row.slug} not distributed: ${row.installPath} is already in use`, {
        operation: "agent_services_row_collision",
        slug: row.slug,
        installPath: row.installPath,
      });
      continue;
    }
    taken.add(row.installPath);
    out.push(row);
  }
  return out;
}

export const FULL_SUBSTRATE_CATALOG: readonly CatalogEntry[] = combineCatalog(
  FLEET_SUBSTRATE_CATALOG,
  serviceCatalogRows(DISCOVERED_SERVICES),
);
