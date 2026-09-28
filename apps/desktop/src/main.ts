import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { startAgentServer, type AgentServerHandle } from "@netnavr/shell-server";
import {
  CORE_STATUS_CHANNEL,
  fetchConfiguredCoreStatus,
  type CoreStatusResult,
} from "./core-status.js";
import {
  normalizeTrustedExternalUrl,
  SHELL_CONNECTION_CHANNEL,
  type ShellConnectionInfo,
} from "./security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rendererPath = path.resolve(__dirname, "../../web/dist/index.html");
const rendererUrl = pathToFileURL(rendererPath).href;

let mainWindow: BrowserWindow | null = null;
let agentServer: AgentServerHandle | null = null;

async function createWindow() {
  if (!agentServer) {
    const configuredWorkspace = process.env.NETNAVR_SHELL_WORKSPACE?.trim();
    const workspaceRoot = configuredWorkspace
      ? path.resolve(configuredWorkspace)
      : path.join(app.getPath("userData"), "workspace");

    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    agentServer = await startAgentServer({
      host: "127.0.0.1",
      port: 0,
      workspaceRoot
    });
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "NetNavr Shell",
    backgroundColor: "#f6f7f5",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true
    }
  });

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
    if (
      !isTrustedRenderer(event) ||
      !agentServer
    ) {
      throw new Error("Shell connection information is unavailable");
    }

    return {
      webSocketUrl: agentServer.webSocketUrl,
      sessionToken: agentServer.sessionToken
    };
  });

  ipcMain.handle(CORE_STATUS_CHANNEL, async (event): Promise<CoreStatusResult> => {
    if (!isTrustedRenderer(event)) {
      throw new Error("Core status is unavailable");
    }

    return fetchConfiguredCoreStatus(process.env.NETNAVR_CORE_PORT);
  });
}

function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
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

app.setName("NetNavr Shell");

await app.whenReady();
installDesktopBridges();
installMenu();
await createWindow();

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("before-quit", async (event) => {
  if (!agentServer) return;

  event.preventDefault();
  const server = agentServer;
  agentServer = null;
  await server.close().catch((error: unknown) => {
    console.error("Failed to close agent server", error);
  });
  app.quit();
});
