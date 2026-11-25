// Copies each agent service's non-code files (skill/, bin/) into the backend
// build, next to its compiled service.js, keeping file modes. The server
// finds services, and the distributor finds their skills and scripts, by
// reading those folders. See src/backend/agent-services/README.md.
// Removed files are cleared first so a stale copy is never pushed to hosts.
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const SRC = "src/backend/agent-services/services";
const DEST = "dist/backend/backend/agent-services/services";

for (const service of existsSync(DEST) ? readdirSync(DEST, { withFileTypes: true }) : []) {
  if (!service.isDirectory()) continue;
  for (const sub of ["skill", "bin"]) {
    rmSync(path.join(DEST, service.name, sub), { recursive: true, force: true });
  }
}
cpSync(SRC, DEST, {
  recursive: true,
  filter: (src) => !src.endsWith(".ts"),
});
