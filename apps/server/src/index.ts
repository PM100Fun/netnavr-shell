import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

export { startAgentServer } from "./agentServer.js";
export type { AgentServerHandle, AgentServerOptions } from "./agentServer.js";

import { startAgentServer } from "./agentServer.js";

// Importing the reusable server package must never open a listener. Only its
// explicit CLI entry starts the retained development prototype.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const handle = await startAgentServer();
  console.log(`netnavr-shell server listening on ${handle.url}`);
}
