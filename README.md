# NetNavr Shell

A macOS-first desktop interaction prototype for NetNavr, using Electron, React
and a local agent server. This source initialization is not a completed MVP or
an accepted App release.

## What works today

- A desktop/web interaction surface with a local mock runner and Codex adapter.
- Bounded event parsing, cancellation, reconnect handling and renderer boundaries.
- Read-only status and identity display from [NetNavr Core](https://github.com/PM100Fun/netnavr-core).

The mock runner is not a second real provider. Official login flows, two real
providers, durable Tasks/conversations, complete permission and recovery flows,
and real Mac install/upgrade acceptance remain to be validated or implemented.

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

For desktop development on a Mac, use `npm run dev:mac`. The shell starts its own
local agent server. Start Core separately using its README if you want live Core
status; `NETNAVR_CORE_PORT` selects the Core loopback port. The existing App build
does not bundle or launch a Core/Node service. `npm run test:integration` starts
the pinned Core in temporary storage and verifies real HTTP identity, shutdown
and restart behavior without provider authentication or personal data.

## Ownership and compatibility

`apps/desktop` owns Electron, `apps/web` owns rendering, `apps/server` owns the
current interaction server, and `packages/` owns Shell-local transport and
adapter code. Core owns persistent runtime identity and the cross-repository
HTTP contract in `@netnavr/core/contract`. Shell owns App builds and future
authorized App distribution; Core does not publish installers.

| Identity | Value |
| --- | --- |
| Shell component | 0.1.2 |
| Core component validated by the pin | 0.2.2 |
| Core commit | `b45f796b9f01b85cd5d779b8510e5ea8c8889f15` |
| Core HTTP API / data schema | v1 / 1 |
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

## Roadmap and 中文说明

The product roadmap separately runs from 0.1 to 1.0: establish and validate the
macOS foundation, deliver Tasks first, then complete the agreed continuity,
provider, permission, memory and recovery outcomes before human acceptance and
authorized release. T3 Code is the chosen engineering direction and CodexMonitor
the visual reference; no upstream reference checkout is bundled by this split.
The current imported prototype is not proof that the planned foundation
transition or full MVP has been implemented.

本仓保留旧总仓 v0.2.33 的 Shell 修复，组件由 0.1.1 调整为 0.1.2。
Core 通过公开仓固定提交获取，不依赖本机其他目录。产品 0.1—1.0、组件版本、
协议与数据 Schema 分开记录。当前只有 mock 和 Codex 接入代码，不能宣传成
两个真实 Provider 已通过。Tasks 首发、官方登录、Mac 安装升级和恢复、Rex
人工验收仍需对应版本的真实证据。Pay 不属于本次 MVP，也没有导入本仓。

## Community and license

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md),
[Governance](GOVERNANCE.md) and [Code of Conduct](CODE_OF_CONDUCT.md).
Apache-2.0; provenance and dependency attribution remain in [NOTICE](NOTICE).
