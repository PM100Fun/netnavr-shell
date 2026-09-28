export const SHELL_CONNECTION_CHANNEL = "netnavr:shell-connection";

export type ShellConnectionInfo = {
  readonly webSocketUrl: string;
  readonly sessionToken: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export function parseShellConnectionInfo(value: unknown): ShellConnectionInfo {
  if (!isRecord(value)) {
    throw new TypeError("Shell connection information must be an object");
  }

  const { webSocketUrl, sessionToken } = value;
  if (typeof webSocketUrl !== "string" || typeof sessionToken !== "string") {
    throw new TypeError("Shell connection information is incomplete");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(webSocketUrl);
  } catch {
    throw new TypeError("Shell WebSocket URL is invalid");
  }

  if (
    parsedUrl.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(parsedUrl.hostname) ||
    parsedUrl.port.length === 0 ||
    parsedUrl.pathname !== "/ws" ||
    parsedUrl.username.length > 0 ||
    parsedUrl.password.length > 0 ||
    parsedUrl.search.length > 0 ||
    parsedUrl.hash.length > 0
  ) {
    throw new TypeError("Shell WebSocket URL must be an explicit loopback /ws endpoint");
  }

  if (!SESSION_TOKEN_PATTERN.test(sessionToken)) {
    throw new TypeError("Shell session token is invalid");
  }

  return { webSocketUrl: parsedUrl.href, sessionToken };
}

export function normalizeTrustedExternalUrl(value: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname.length === 0 ||
    parsedUrl.username.length > 0 ||
    parsedUrl.password.length > 0
  ) {
    return null;
  }

  return parsedUrl.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
