/**
 * per-app-archive-file.ts — where this backend's own machine keeps its
 * archived apps, through the bind mount. Archiving and un-archiving are
 * requests to the machine's front door (fleet-change); this module only says
 * where the archive is, for the archived-apps list.
 */

import path from "path";
import os from "os";

/**
 * The local archived-apps root: APPS_ARCHIVE_HOST_DIR (bind-mount / test
 * override), else <HOME_HOST_DIR or os.homedir()>/fleet/apps-archive.
 */
export function getLocalArchivedAppsRoot(): string {
  return (
    process.env.APPS_ARCHIVE_HOST_DIR ||
    path.join(process.env.HOME_HOST_DIR || os.homedir(), "fleet", "apps-archive")
  );
}
