// Copies each agent service's non-code files (skill/, bin/) into the backend
// build, next to its compiled service.js, keeping file modes. The server
// finds services, and the distributor finds their skills and scripts, by
// reading those folders. See src/backend/agent-services/README.md.
import { cpSync } from "node:fs";

cpSync("src/backend/agent-services/services", "dist/backend/backend/agent-services/services", {
  recursive: true,
  filter: (src) => !src.endsWith(".ts"),
});
