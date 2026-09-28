import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import concurrently from "concurrently";

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionToken = randomBytes(32).toString("base64url");
const port = process.env.PORT?.trim() || "8787";
const webSocketUrl = process.env.VITE_NETNAVR_SHELL_WS?.trim() || `ws://127.0.0.1:${port}/ws`;

const { result } = concurrently(
  [
    {
      name: "server",
      command: "npm run dev -w @netnavr/shell-server",
      env: {
        NETNAVR_SHELL_SESSION_TOKEN: sessionToken
      }
    },
    {
      name: "web",
      command: "npm run dev -w @netnavr/shell-web",
      env: {
        VITE_NETNAVR_SHELL_TOKEN: sessionToken,
        VITE_NETNAVR_SHELL_WS: webSocketUrl
      }
    }
  ],
  {
    cwd: shellRoot,
    prefix: "name",
    prefixColors: ["cyan", "magenta"],
    killOthersOn: ["failure", "success"]
  }
);

try {
  await result;
} catch {
  process.exitCode = 1;
}
