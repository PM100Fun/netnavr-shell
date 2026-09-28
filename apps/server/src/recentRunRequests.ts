import type { ShellRequestId } from "@netnavr/shell-protocol";

export const SHELL_MAX_RECENT_RUN_REQUEST_IDS = 512;

export type RecentRunRequestIds = {
  has: (requestId: ShellRequestId) => boolean;
  remember: (requestId: ShellRequestId) => void;
};

export function createRecentRunRequestIds(
  maxEntries = SHELL_MAX_RECENT_RUN_REQUEST_IDS
): RecentRunRequestIds {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("Recent run request ID limit must be a positive safe integer");
  }

  const requestIds = new Set<ShellRequestId>();

  return {
    has: (requestId) => requestIds.has(requestId),
    remember: (requestId) => {
      if (requestIds.has(requestId)) return;

      requestIds.add(requestId);
      if (requestIds.size <= maxEntries) return;

      const oldestRequestId = requestIds.values().next().value;
      if (oldestRequestId !== undefined) requestIds.delete(oldestRequestId);
    }
  };
}
