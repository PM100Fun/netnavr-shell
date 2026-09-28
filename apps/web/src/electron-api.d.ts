import type { CoreStatusResult } from "../../desktop/src/core-status.js";
import type { FixtureCommandInput, FixtureCommandResult } from "@netnavr/core/fixture-contract";
import type { FixtureBridgeResult, FixtureReadout } from "../../desktop/src/fixture-bridge.js";

export {};

declare global {
  interface Window {
    netnavr?: {
      getShellConnection(): Promise<{
        webSocketUrl: string;
        sessionToken: string;
      }>;
      getCoreStatus(): Promise<CoreStatusResult>;
      startFixture(): Promise<FixtureBridgeResult<FixtureReadout>>;
      stopFixture(): Promise<FixtureBridgeResult<FixtureReadout>>;
      getFixture(): Promise<FixtureBridgeResult<FixtureReadout>>;
      submitFixture(input: FixtureCommandInput): Promise<FixtureBridgeResult<FixtureCommandResult>>;
      readFixture(commandId: string): Promise<FixtureBridgeResult<FixtureCommandResult>>;
      cancelFixture(commandId: string): Promise<FixtureBridgeResult<FixtureCommandResult>>;
    };
  }
}
