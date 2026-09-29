import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import {
  CORE_STATUS_CHANNEL,
  type CoreStatusResult,
} from "./core-status.js";
import {
  normalizeTrustedExternalUrl,
  SHELL_CONNECTION_CHANNEL,
  type ShellConnectionInfo,
} from "./security.js";
import { createDesktopWindowOptions, bindFirstReveal, getWindowTitleBarOptions } from "./window/DesktopWindow.js";
import { FixtureOwner } from "./fixture-owner.js";
import { createElectronCoreLauncher } from "./electron-core-launcher.js";
import { FIXTURE_CHANNELS, parseFixtureInput, parseFixtureCommandId } from "./fixture-bridge.js";

import { CodexSyntheticProvider } from "../../../packages/provider-probe/src/codex-synthetic.mjs";
import { ProviderOwner } from "./provider-owner.js";
import { PROVIDER_CHANNELS, parseProviderMarker } from "./provider-bridge.js";
import { bridgeFailure } from "./fixture-bridge.js";

const desktopDirectory = __dirname;
const rendererPath = path.resolve(desktopDirectory, "../../web/dist/index.html");
const rendererUrl = pathToFileURL(rendererPath).href;

let mainWindow: BrowserWindow | null = null;
let quitting = false;
const fixtureOwner = new FixtureOwner(createElectronCoreLauncher(
  app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "apps", "desktop", "dist", "core-worker.cjs")
    : path.join(desktopDirectory, "core-worker.cjs"),
  () => path.join(app.getPath("userData"), "product-0.1-engineering", "fixture-v1"),
));

// Explicit trusted launch configuration; never accept these paths over IPC.
const providerOptions = { executable: process.env.NETNAVR_SYNTHETIC_CODEX, dedicatedHome: process.env.NETNAVR_SYNTHETIC_HOME, evidenceRoot: process.env.NETNAVR_SYNTHETIC_EVIDENCE };
const providerOwner = new ProviderOwner(providerOptions.executable && providerOptions.dedicatedHome && providerOptions.evidenceRoot
  ? new CodexSyntheticProvider(providerOptions as { executable: string; dedicatedHome: string; evidenceRoot: string }) : undefined, fixtureOwner);

async function createWindow() {
  mainWindow = new BrowserWindow(createDesktopWindowOptions({
    platform: process.platform,
    dark: nativeTheme.shouldUseDarkColors,
    preload: path.join(desktopDirectory, "preload.cjs"),
  }));
  const window = mainWindow;
  bindFirstReveal((fire) => window.once("ready-to-show", fire), window);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openTrustedExternalUrl(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === rendererUrl) return;
    event.preventDefault();
    openTrustedExternalUrl(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(rendererPath);
}

function openTrustedExternalUrl(url: string): void {
  const trustedUrl = normalizeTrustedExternalUrl(url);
  if (!trustedUrl) return;

  void shell.openExternal(trustedUrl).catch((error: unknown) => {
    console.error("Failed to open trusted external URL", error);
  });
}

function installDesktopBridges() {
  ipcMain.handle(SHELL_CONNECTION_CHANNEL, (event): ShellConnectionInfo => {
    if (!isTrustedRenderer(event)) throw new Error("Shell connection information is unavailable");
    // The legacy coding prototype is retained as source and tests. Product 0.1
    // does not enable its SDK, server or config inheritance by opening a window.
    throw new Error("Legacy agent server is not enabled in the product 0.1 candidate");
  });

  ipcMain.handle(CORE_STATUS_CHANNEL, async (event): Promise<CoreStatusResult> => {
    if (!isTrustedRenderer(event)) {
      throw new Error("Core status is unavailable");
    }

    return { state: "offline", code: "unreachable", message: "Use the explicit product 0.1 engineering Core controls" };
  });
  for (const [action, channel] of Object.entries(PROVIDER_CHANNELS)) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!isTrustedRenderer(event)) throw new Error("Provider bridge is unavailable");
      if (action !== "run" && input !== undefined) throw new TypeError("Operation takes no arguments");
      if (action === "run") return providerOwner.run(parseProviderMarker(input));
      if (action === "preflight") return providerOwner.preflight();
      if (action === "cancel") return providerOwner.cancel();
      return providerOwner.status();
    });
  }
  for (const [action, channel] of Object.entries(FIXTURE_CHANNELS)) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!isTrustedRenderer(event)) throw new Error("Engineering bridge is unavailable");
      if (["start", "stop", "state"].includes(action) && input !== undefined) throw new TypeError("Engineering operation takes no arguments");
      switch (action) {
        case "start": return providerOwner.busy ? bridgeFailure("provider_busy", "Wait for the provider operation") : fixtureOwner.start();
        case "stop": return await providerOwner.stop() ? fixtureOwner.stop() : bridgeFailure("provider_cleanup_unconfirmed", "Provider shutdown was not confirmed");
        case "state": return fixtureOwner.state();
        case "submit": return providerOwner.busy ? bridgeFailure("provider_busy", "Wait for the provider operation") : fixtureOwner.submit(parseFixtureInput(input));
        case "read": return fixtureOwner.read(parseFixtureCommandId(input));
        case "cancel": return fixtureOwner.cancel(parseFixtureCommandId(input));
        default: throw new Error("Unknown engineering operation");
      }
    });
  }
}

function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    event.senderFrame?.url === rendererUrl
  );
}

function installMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "File",
      submenu: [{ role: "close" }]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName("NetNavr Engineering 0.1");

async function bootstrap(): Promise<void> {
  await app.whenReady();
  installDesktopBridges();
  installMenu();
  await createWindow();
}
void bootstrap().catch(() => {
  console.error("NetNavr engineering window could not start");
  app.exit(1);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

// Electron quits by default when the last window closes unless this event
// has a listener. On macOS the owned Core belongs to the App session, so keep
// it alive until the user quits and let activate recreate the window.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (!await providerOwner.stop()) { quitting = false; console.error("Owned provider shutdown was not confirmed"); return; }
  const result = await fixtureOwner.stop();
  if (!result.ok) {
    quitting = false;
    console.error("Owned engineering Core shutdown was not confirmed; App remains open");
    return;
  }
  app.quit();
});

nativeTheme.on("updated", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");
  const { titleBarOverlay } = getWindowTitleBarOptions(nativeTheme.shouldUseDarkColors, process.platform);
  if (typeof titleBarOverlay === "object") mainWindow.setTitleBarOverlay(titleBarOverlay);
});
