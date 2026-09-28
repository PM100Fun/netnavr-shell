import { contextBridge, ipcRenderer } from "electron";

import {
  CORE_STATUS_CHANNEL,
  parseCoreStatusResult,
} from "./core-status.js";
import {
  parseShellConnectionInfo,
  SHELL_CONNECTION_CHANNEL,
} from "./security.js";
import { FIXTURE_CHANNELS, parseFixtureInput, parseFixtureCommandId, parseBridgeResult,
  parseFixtureCommandResult, parseFixtureReadout } from "./fixture-bridge.js";

contextBridge.exposeInMainWorld(
  "netnavr",
  Object.freeze({
    getShellConnection: async () => {
      const resolved = await ipcRenderer.invoke(SHELL_CONNECTION_CHANNEL).then(parseShellConnectionInfo);
      return { ...resolved };
    },
    getCoreStatus: async () =>
      parseCoreStatusResult(await ipcRenderer.invoke(CORE_STATUS_CHANNEL)),
    startFixture: async () => parseBridgeResult(await ipcRenderer.invoke(FIXTURE_CHANNELS.start), parseFixtureReadout),
    stopFixture: async () => parseBridgeResult(await ipcRenderer.invoke(FIXTURE_CHANNELS.stop), parseFixtureReadout),
    getFixture: async () => parseBridgeResult(await ipcRenderer.invoke(FIXTURE_CHANNELS.state), parseFixtureReadout),
    submitFixture: async (input: unknown) => parseBridgeResult(await ipcRenderer.invoke(FIXTURE_CHANNELS.submit, parseFixtureInput(input)), parseFixtureCommandResult),
    readFixture: async (id: unknown) => parseBridgeResult(await ipcRenderer.invoke(FIXTURE_CHANNELS.read, parseFixtureCommandId(id)), parseFixtureCommandResult),
    cancelFixture: async (id: unknown) => parseBridgeResult(await ipcRenderer.invoke(FIXTURE_CHANNELS.cancel, parseFixtureCommandId(id)), parseFixtureCommandResult),
  }),
);
