// Adapted from T3 Tools Inc., MIT licensed.
// https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/desktop/src/window/DesktopWindow.ts
// NetNavr keeps the window assembly/reveal pattern; Effect services, previews,
// webviews, remote environments, telemetry and coding state are not included.
import type { BrowserWindowConstructorOptions } from "electron";

export const T3_DESKTOP_SOURCE = Object.freeze({
  repository: "https://github.com/pingdotgg/t3code",
  commit: "de251fc2971a884cb5b1305ba4daf309dc8cccb0",
  file: "apps/desktop/src/window/DesktopWindow.ts",
});

export function createDesktopWindowOptions(input: {
  platform: NodeJS.Platform;
  dark: boolean;
  preload: string;
}): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...(input.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
    backgroundColor: input.dark ? "#0a0a0a" : "#ffffff",
    title: "NetNavr · Product 0.1 engineering candidate",
    ...getWindowTitleBarOptions(input.dark, input.platform),
    webPreferences: {
      preload: input.preload,
      // Match T3's hidden first-paint assembly, then re-enable in bindFirstReveal.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // NetNavr has no embedded remote preview or coding webview.
      webviewTag: false,
    },
  };
}

export function getWindowTitleBarOptions(dark: boolean, platform: NodeJS.Platform):
  Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"> {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 19 } };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#01000000",
      height: 40,
      symbolColor: dark ? "#f8fafc" : "#1f2937",
    },
  };
}

// T3's first-reveal subscription pattern, without Effect service dependencies.
export function bindFirstReveal(
  subscribe: (fire: () => void) => void,
  window: {
    isDestroyed(): boolean;
    show(): void;
    webContents: { setBackgroundThrottling(enabled: boolean): void };
  },
): void {
  let revealed = false;
  subscribe(() => {
    if (revealed || window.isDestroyed()) return;
    revealed = true;
    window.webContents.setBackgroundThrottling(true);
    window.show();
  });
}
