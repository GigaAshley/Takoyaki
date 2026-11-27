/**
 * per-role-archive-file.ts — where this backend's own machine keeps its
 * archived roles, through the bind mount. Archiving and un-archiving are
 * requests to the machine's front door (fleet-change); this module only says
 * where the archive is, for the archived-roles list.
 */

import path from "path";
import os from "os";

/**
 * The local archived-roles root: ROLES_ARCHIVE_HOST_DIR (bind-mount / test
 * override), else <HOME_HOST_DIR or os.homedir()>/fleet/roles-archive.
 */
export function getLocalArchivedRolesRoot(): string {
  return (
    process.env.ROLES_ARCHIVE_HOST_DIR ||
    path.join(process.env.HOME_HOST_DIR || os.homedir(), "fleet", "roles-archive")
  );
}
