import type { CoreStatusResult } from "../../desktop/src/core-status.js";

export {};

declare global {
  interface Window {
    netnavr?: {
      getShellConnection(): Promise<{
        webSocketUrl: string;
        sessionToken: string;
      }>;
      getCoreStatus(): Promise<CoreStatusResult>;
    };
  }
}
