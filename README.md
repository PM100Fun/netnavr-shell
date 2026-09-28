# NetNavr Shell

A macOS-first desktop interaction shell for NetNavr, using Electron and React.
Product 0.1 is an engineering candidate and a review of four product flows; it
does not yet provide the complete Navigator, Tasks, Memory or recovery product.

## What works today

- A T3-derived, sandboxed desktop window with a fixed preload bridge.
- Explicit startup of an App-owned Core utility process, bundled with the exact
  [NetNavr Core](https://github.com/PM100Fun/netnavr-core) dependency.
- Real authenticated synthetic-marker commands, idempotent replay, cancellation,
  bounded readback and isolated-fixture persistence across Core restarts.
- Clearly labelled clickable design reviews for conversation, task confirmation,
  memory and recovery; these never save product data or invoke a model.
- The previous prototype's parsing, response limits and cancellation regression
  tests remain in the repository. Its coding server and SDK do not automatically
  start in the product 0.1 App or browser review.

Official-tool probes report their own evidence. Real model runs are disabled
until configuration inheritance, hooks/MCP, tool/file permissions and outbound
context boundaries are verified. A mock, a marker command or a login-status check
is not a real-provider conversation. Mac GUI, installation, upgrade, recovery,
signing and user acceptance require separate actual-machine evidence.

## Quick start

Use Node.js 24 or newer, npm and Git. Installation fetches Core from a pinned
public Git commit and builds it; no sibling checkout or private path is needed.

```sh
git clone https://github.com/PM100Fun/netnavr-shell.git
cd netnavr-shell
npm ci
npm run verify
npm run dev
```

`npm run dev` is a browser design review with no desktop bridge. On a Mac, use
`npm run dev:mac` to start the engineering window. Click **显式启动 Core**, choose
`alpha` or `beta`, then submit and read the real result. The synthetic fixture is
stored separately from user product data. Stopping/restarting preserves its
marker/revision while session IDs and the command ledger reset. Closing a window
keeps the current App session; quitting stops only the App-owned utility process.

The App uses Electron's embedded Node runtime; it does not rely on a globally
installed Node to run Core after packaging. `npm run test:integration` tests the
real fixed Core and the actual bundled worker in temporary storage.
`npm run test:electron-runtime` explicitly checks embedded `node:sqlite`, an owned
utility process and restart readback without opening a window. This technical
check does not constitute App installation or GUI acceptance.

## Ownership and compatibility

`apps/desktop` owns Electron, `apps/web` owns rendering, `apps/server` owns the
retained prototype interaction server, and `packages/` owns Shell-local transport,
adapter and official-tool probe code. Core owns persistent runtime identity and
the cross-repository contracts in `@netnavr/core/contract` and
`@netnavr/core/fixture-contract`. Shell owns App builds and future
authorized App distribution; Core does not publish installers.

| Identity | Value |
| --- | --- |
| Product / internal App target | 0.1 / 0.1.0-alpha.1 |
| Shell component | 0.1.3 |
| Core component fixed by the pin | 0.2.3 |
| Core commit | `c1c33130e5a5a6f807af094bc24a799dbde38d03` |
| Core HTTP API / data schema | v1 / 1 |
| Engineering fixture contract / schema | fixture-v1 / 1 (isolated, not product data) |
| Shell WebSocket protocol | 3 |
| Import baseline | NetNavr v0.2.33, `ca6002d580cef51cab869a3a65cbcddc2dfed3c1` |
| Previous Shell component | 0.1.1 |

The exact Core source is recorded in `package.json` and `package-lock.json`.
To update it, publish and verify Core first, change the explicit commit, regenerate
the lock, then run the full Shell suite and integration test. Keep the previous
validated pair available until the new candidate is accepted. A partial source
publication does not switch users to an unvalidated pair.

`npm run verify` tests, type checks, builds and runs the cross-repository test.
CI exercises Ubuntu, Windows and macOS source checks. It does not perform GUI
acceptance, login, install/upgrade/recovery, signing, notarization or release.
Existing `package:mac`/`dist:mac` commands are local packaging commands only;
their output requires explicit candidate validation before distribution.
Builds stage the pinned Core notices and renderer dependency licenses alongside
the bundled code. The actual Mac package must retain those files.

## Roadmap and 中文说明

The product roadmap runs from 0.1 to 1.0: establish and validate the
macOS foundation, deliver Tasks first, then complete the agreed continuity,
provider, permission, memory and recovery outcomes before human acceptance and
authorized release. T3 Code is the chosen engineering direction. From fixed
commit `de251fc2971a884cb5b1305ba4daf309dc8cccb0`, the minimal adaptation uses
`DesktopWindow.ts` for platform titlebars, safe window assembly and first reveal;
`apps/desktop/vite.config.ts` and `scripts/lib/desktop-external-packages.ts` inform
CJS main/worker bundling and self-contained preloads. The original Effect service
graph, IDE state, webviews, remote services, telemetry and update servers are not
enabled. This is a bounded desktop assembly adaptation, not proof that the full
upstream T3 App has been built or run on a Mac.

CodexMonitor commit `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5` is the visual
reference for sidebar/content hierarchy and restrained themes. NetNavr uses its
own solid-surface CSS tokens, with system light/dark themes and narrow-window
layouts; it does not import CodexMonitor's Tauri runtime or private platform APIs.

本仓保留旧总仓 v0.2.33 的有效回归。产品0.1通过T3最小桌面装配、受限桥、
App归属Core进程与合成marker往返验证工程边界；四组流程页面明确标为设计稿。
Core以完整公开提交固定，产品/App、组件、协议与Schema分别记录。官方工具的
权限与配置继承边界未完成验证，当前工程App关闭真实模型运行。Mac实际安装、
升级恢复、签名公证与人工验收需要相应实机证据。Pay没有导入本仓。

## Community and license

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md),
[Governance](GOVERNANCE.md) and [Code of Conduct](CODE_OF_CONDUCT.md).
Apache-2.0; provenance and dependency attribution remain in [NOTICE](NOTICE).
