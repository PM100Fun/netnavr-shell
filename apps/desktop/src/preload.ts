import { contextBridge, ipcRenderer } from "electron";

import {
  CORE_STATUS_CHANNEL,
  parseCoreStatusResult,
} from "./core-status.js";
import {
  parseShellConnectionInfo,
  SHELL_CONNECTION_CHANNEL,
} from "./security.js";

const connection = ipcRenderer
  .invoke(SHELL_CONNECTION_CHANNEL)
  .then(parseShellConnectionInfo);

contextBridge.exposeInMainWorld(
  "netnavr",
  Object.freeze({
    getShellConnection: async () => {
      const resolved = await connection;
      return { ...resolved };
    },
    getCoreStatus: async () =>
      parseCoreStatusResult(await ipcRenderer.invoke(CORE_STATUS_CHANNEL)),
  }),
);
