import "dotenv/config";

export { startAgentServer } from "./agentServer.js";
export type { AgentServerHandle, AgentServerOptions } from "./agentServer.js";

import { startAgentServer } from "./agentServer.js";

const handle = await startAgentServer();
console.log(`netnavr-shell server listening on ${handle.url}`);
