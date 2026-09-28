import assert from "node:assert/strict";
import test from "node:test";
import { bindFirstReveal, createDesktopWindowOptions } from "../src/window/DesktopWindow.js";

test("T3-derived desktop assembly keeps macOS titlebar and sandboxed local window", () => {
  const options = createDesktopWindowOptions({ platform: "darwin", dark: false, preload: "local-preload.cjs" });
  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.deepEqual(options.trafficLightPosition, { x: 16, y: 19 });
  assert.equal(options.show, false);
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(options.webPreferences?.contextIsolation, true);
  assert.equal(options.webPreferences?.nodeIntegration, false);
  assert.equal(options.webPreferences?.webviewTag, false);
});

test("hidden-window first reveal restores throttling exactly once", () => {
  let fire: () => void = () => { throw new Error("not subscribed"); };
  const calls: string[] = [];
  let destroyed = false;
  bindFirstReveal((callback) => { fire = callback; }, {
    isDestroyed: () => destroyed,
    show: () => calls.push("show"),
    webContents: { setBackgroundThrottling: (enabled) => calls.push(`throttle:${enabled}`) },
  });
  fire();
  fire();
  assert.deepEqual(calls, ["throttle:true", "show"]);
  destroyed = true;
  fire();
  assert.deepEqual(calls, ["throttle:true", "show"]);
});

test("a destroyed hidden window cannot be revealed", () => {
  let fire: () => void = () => undefined;
  bindFirstReveal((callback) => { fire = callback; }, {
    isDestroyed: () => true,
    show: () => assert.fail("destroyed window shown"),
    webContents: { setBackgroundThrottling: () => assert.fail("destroyed window changed") },
  });
  fire();
});
