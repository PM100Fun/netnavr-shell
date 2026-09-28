import {
  Activity,
  Bot,
  Cpu,
  Play,
  RefreshCw,
  Server,
  Square,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  parseShellEvent,
  type AgentProvider,
  type ClientRunRequest,
  type ShellEvent,
  type ShellRequestId,
  type ShellRunId
} from "@netnavr/shell-protocol";

import {
  startShellConnection,
  type ShellConnectionInfo,
  type ShellSocket
} from "./shellConnection";
import {
  appendBoundedItem,
  appendBoundedStreamText,
  SHELL_MAX_EVENT_ROWS
} from "./rendererBuffers";

type CoreStatusResult = Awaited<
  ReturnType<NonNullable<Window["netnavr"]>["getCoreStatus"]>
>;

const DEFAULT_DEVELOPMENT_WEBSOCKET_URL = "ws://127.0.0.1:8787/ws";

type Line = {
  id: string;
  event: ShellEvent;
};

export function App() {
  const socketRef = useRef<ShellSocket | null>(null);
  const activeRunIdRef = useRef<ShellRunId | null>(null);
  const pendingRequestIdRef = useRef<ShellRequestId | null>(null);
  const nextLineIdRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<ShellRunId | null>(null);
  const [providers, setProviders] = useState<AgentProvider[]>(["mock"]);
  const [provider, setProvider] = useState<AgentProvider>("mock");
  const [prompt, setPrompt] = useState("Summarize the current NetNavr Shell and suggest the next implementation step.");
  const [workspace, setWorkspace] = useState("Managed by NetNavr");
  const [model, setModel] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [coreStatus, setCoreStatus] = useState<CoreStatusResult | null>(null);
  const [coreStatusError, setCoreStatusError] = useState<string | null>(null);
  const [checkingCore, setCheckingCore] = useState(false);

  useEffect(() => {
    const connection = startShellConnection({
      resolveConnection: resolveShellConnection,
      onSocket: (socket) => {
        socketRef.current = socket;
      },
      onConnected: () => setConnected(true),
      onDisconnected: () => {
        activeRunIdRef.current = null;
        pendingRequestIdRef.current = null;
        setConnected(false);
        setRunning(false);
        setActiveRunId(null);
      },
      onMessage: (message) => {
        let rawEvent: unknown;
        try {
          rawEvent = JSON.parse(message);
        } catch {
          return;
        }

        const event = parseShellEvent(rawEvent);
        if (event.ok) receive(event.value);
      },
      onInitializationError: () => {
        setLines([
          {
            id: "missing-session-token",
            event: { type: "log", level: "error", message: "Unable to initialize local shell connection" }
          }
        ]);
      }
    });

    return () => connection.stop();
  }, []);

  useEffect(() => {
    let active = true;
    if (!window.netnavr) return () => undefined;

    setCheckingCore(true);
    window.netnavr
      .getCoreStatus()
      .then((result) => {
        if (!active) return;
        setCoreStatus(result);
        setCoreStatusError(null);
      })
      .catch(() => {
        if (!active) return;
        setCoreStatus(null);
        setCoreStatusError("The desktop bridge could not read Core status");
      })
      .finally(() => {
        if (active) setCheckingCore(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const status = useMemo(() => {
    if (running) return "running";
    return connected ? "ready" : "offline";
  }, [connected, running]);

  function receive(event: ShellEvent) {
    if (event.type === "shell.ready") {
      setProviders(event.providers);
      setWorkspace(event.workspace);
      if (event.providers.length > 0) setProvider(event.providers[0]);
      return;
    }

    if (event.type === "run.started") {
      if (event.requestId !== pendingRequestIdRef.current) return;
      pendingRequestIdRef.current = null;
      activeRunIdRef.current = event.runId;
      setActiveRunId(event.runId);
    } else if (event.type === "run.rejected") {
      if (event.requestId !== pendingRequestIdRef.current) return;
      pendingRequestIdRef.current = null;
      activeRunIdRef.current = null;
      setActiveRunId(null);
      setRunning(false);
    } else {
      const eventRunId = getRunId(event);
      if (eventRunId && eventRunId !== activeRunIdRef.current) return;
    }

    if (event.type === "thread.started") {
      setThreadId(event.threadId);
    }

    if (event.type === "agent.delta") {
      setStreamText((current) => appendBoundedStreamText(current, event.text));
    }

    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "run.cancelled"
    ) {
      activeRunIdRef.current = null;
      setActiveRunId(null);
      setRunning(false);
    }

    const line = {
      id: `event-${nextLineIdRef.current}`,
      event
    };
    nextLineIdRef.current += 1;
    setLines((current) => appendBoundedItem(current, line));
  }

  async function refreshCoreStatus() {
    if (!window.netnavr || checkingCore) return;

    setCheckingCore(true);
    setCoreStatusError(null);
    try {
      setCoreStatus(await window.netnavr.getCoreStatus());
    } catch {
      setCoreStatus(null);
      setCoreStatusError("The desktop bridge could not read Core status");
    } finally {
      setCheckingCore(false);
    }
  }

  function run() {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    if (pendingRequestIdRef.current || activeRunIdRef.current) return;
    if (!prompt.trim() || prompt.length > 64_000) return;

    setRunning(true);
    setStreamText("");
    setLines([]);
    activeRunIdRef.current = null;
    setActiveRunId(null);

    const request: ClientRunRequest = {
      provider,
      prompt,
      threadId: threadId || undefined,
      model: model.trim() || undefined,
      reasoningEffort: "medium"
    };
    const requestId = createRequestId();
    pendingRequestIdRef.current = requestId;

    try {
      socketRef.current.send(JSON.stringify({ type: "run", requestId, request }));
    } catch {
      pendingRequestIdRef.current = null;
      setRunning(false);
    }
  }

  function cancel() {
    const runId = activeRunIdRef.current;
    if (!runId || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "cancel", runId }));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <Terminal size={19} aria-hidden="true" />
          <span>NetNavr Shell</span>
        </div>
        <div className={`status ${status}`}>
          <Activity size={15} aria-hidden="true" />
          <span>{status}</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="leftpane">
          <label>
            <span>Provider</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value as AgentProvider)}>
              {providers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="default" />
          </label>

          <label>
            <span>Managed Workspace</span>
            <input value={workspace} readOnly aria-readonly="true" />
          </label>

          <section className="core-card" aria-live="polite">
            <div className="core-card-head">
              <div>
                <Server size={16} aria-hidden="true" />
                <span>Node Status</span>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={refreshCoreStatus}
                disabled={!window.netnavr || checkingCore}
                title="Refresh Core status"
                aria-label="Refresh Core status"
              >
                <RefreshCw
                  size={15}
                  aria-hidden="true"
                  className={checkingCore ? "spinning" : undefined}
                />
              </button>
            </div>

            <div
              className={`core-state core-${checkingCore ? "checking" : coreStatus?.state ?? "unavailable"}`}
            >
              {checkingCore
                ? "checking"
                : coreStatus?.state ?? (window.netnavr ? "not checked" : "desktop only")}
            </div>

            {coreStatus?.state === "online" ? (
              <dl className="core-details">
                <div>
                  <dt>Core</dt>
                  <dd>{coreStatus.version}</dd>
                </div>
                <div>
                  <dt>API</dt>
                  <dd>{coreStatus.apiVersion}</dd>
                </div>
                <div>
                  <dt>Schema</dt>
                  <dd>{coreStatus.schemaVersion}</dd>
                </div>
                <div>
                  <dt>Uptime</dt>
                  <dd>{formatUptime(coreStatus.uptimeSeconds)}</dd>
                </div>
                <div className="core-detail-wide">
                  <dt>Node ID</dt>
                  <dd>{coreStatus.nodeId}</dd>
                </div>
                <div className="core-detail-wide">
                  <dt>Created</dt>
                  <dd>{coreStatus.createdAt}</dd>
                </div>
              </dl>
            ) : null}

            {coreStatus && coreStatus.state !== "online" ? (
              <div className="core-message">
                <strong>{coreStatus.code.replaceAll("_", " ")}</strong>
                <span>{coreStatus.message}</span>
                {coreStatus.requestId ? <small>{coreStatus.requestId}</small> : null}
              </div>
            ) : null}

            {coreStatusError ? (
              <div className="core-message">
                <span>{coreStatusError}</span>
              </div>
            ) : null}
          </section>

          <div className="threadbox">
            <Bot size={16} aria-hidden="true" />
            <span>{threadId ?? "new thread"}</span>
          </div>
        </aside>

        <section className="mainpane">
          <div className="composer">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <div className="actions">
              <button type="button" onClick={run} disabled={!connected || running} title="Run">
                <Play size={17} aria-hidden="true" />
                <span>Run</span>
              </button>
              <button type="button" onClick={cancel} disabled={!running || !activeRunId} title="Cancel">
                <Square size={16} aria-hidden="true" />
                <span>Stop</span>
              </button>
            </div>
          </div>

          <div className="output">
            <div className="output-head">
              <Cpu size={16} aria-hidden="true" />
              <span>Agent Output</span>
            </div>
            <pre>{streamText || "Waiting for a run."}</pre>
          </div>
        </section>

        <aside className="rightpane">
          <div className="event-title">Events · latest {SHELL_MAX_EVENT_ROWS}</div>
          <div className="events">
            {lines.map(({ id, event }) => (
              <EventRow key={id} event={event} />
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

function createRequestId(): ShellRequestId {
  return `req_${crypto.randomUUID()}`;
}

function getRunId(event: ShellEvent): ShellRunId | null {
  return "runId" in event && event.runId ? event.runId : null;
}

function formatUptime(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

async function resolveShellConnection(): Promise<ShellConnectionInfo> {
  const developmentToken = import.meta.env.VITE_NETNAVR_SHELL_TOKEN?.trim();
  const developmentWebSocketUrl = import.meta.env.VITE_NETNAVR_SHELL_WS?.trim();

  if (developmentToken || developmentWebSocketUrl) {
    if (!developmentToken) {
      throw new Error("Missing development shell session token");
    }
    return {
      webSocketUrl: developmentWebSocketUrl || DEFAULT_DEVELOPMENT_WEBSOCKET_URL,
      sessionToken: developmentToken
    };
  }

  if (!window.netnavr) {
    throw new Error("Shell connection bridge is unavailable");
  }
  return window.netnavr.getShellConnection();
}

function EventRow({ event }: { event: ShellEvent }) {
  const label = event.type;
  let detail = "";

  if ("message" in event) detail = event.message;
  if ("item" in event) detail = event.item.title ?? event.item.type;
  if (event.type === "run.started" || event.type === "run.cancelled") detail = event.runId;
  if (event.type === "run.rejected" || event.type === "cancel.rejected") detail = event.reason;
  if (event.type === "thread.started") detail = event.threadId;
  if (event.type === "turn.failed") detail = event.error;
  if (event.type === "turn.completed") detail = event.usage ? `${event.usage.inputTokens} in / ${event.usage.outputTokens} out` : "done";

  return (
    <div className="event-row">
      <span>{label}</span>
      <small>{detail}</small>
    </div>
  );
}
