import { utilityProcess } from "electron";
import type { LaunchOwnedCore } from "./fixture-owner.js";
import { launchOwnedCoreChild } from "./owned-core-launcher.js";

export function createElectronCoreLauncher(workerPath: string, dataDirectory: () => string): LaunchOwnedCore {
  return (token, signal) => {
    if (signal.aborted) return Promise.reject(new Error("Startup cancelled"));
    const directory = dataDirectory();
    const child = utilityProcess.fork(workerPath, [], { stdio: "ignore", serviceName: "NetNavr engineering Core" });
    return launchOwnedCoreChild({
      onSpawn: (callback) => { child.once("spawn", callback); },
      onMessage: (callback) => { child.on("message", callback); },
      onExit: (callback) => { child.once("exit", callback); },
      postMessage: (value) => { child.postMessage(value); },
      kill: () => { child.kill(); },
    }, token, directory, signal);
  };
}
