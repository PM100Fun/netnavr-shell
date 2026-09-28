import { Codex } from "@openai/codex-sdk";
import type { RoutedAgent } from "@netnavr/shell-model-router";
import type { AgentItem, RunRequest, ShellEvent, Usage } from "@netnavr/shell-protocol";

type CodexThread = {
  id: string | null;
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{
    events: AsyncGenerator<unknown>;
  }>;
};

export class CodexAgent implements RoutedAgent {
  readonly provider = "codex" as const;
  private readonly codex: Codex;

  constructor() {
    this.codex = new Codex();
  }

  async *run(request: RunRequest, signal?: AbortSignal): AsyncGenerator<ShellEvent> {
    const thread = this.createThread(request);

    yield {
      type: "log",
      runId: request.runId,
      level: "info",
      message: "Starting Codex turn"
    };

    try {
      const streamed = await thread.runStreamed(request.prompt, { signal });

      for await (const rawEvent of streamed.events) {
        const mapped = mapCodexEvent(rawEvent, request, thread.id);
        for (const event of mapped) {
          yield event;
        }
      }
    } catch (error) {
      yield {
        type: "turn.failed",
        runId: request.runId,
        provider: this.provider,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private createThread(request: RunRequest): CodexThread {
    const options = {
      model: request.model || undefined,
      workingDirectory: request.cwd || undefined,
      sandboxMode: request.sandboxMode || undefined,
      approvalPolicy: request.approvalPolicy || undefined,
      modelReasoningEffort: request.reasoningEffort || undefined
    };

    if (request.threadId) {
      return this.codex.resumeThread(request.threadId, options) as CodexThread;
    }
    return this.codex.startThread(options) as CodexThread;
  }
}

function mapCodexEvent(rawEvent: unknown, request: RunRequest, currentThreadId: string | null): ShellEvent[] {
  const event = rawEvent as Record<string, unknown>;
  const type = String(event.type ?? "");

  if (type === "thread.started") {
    return [
      {
        type: "thread.started",
        runId: request.runId,
        provider: "codex",
        threadId: String(event.thread_id ?? currentThreadId ?? "")
      }
    ];
  }

  if (type === "turn.started") {
    return [{ type: "turn.started", runId: request.runId, provider: "codex", threadId: currentThreadId }];
  }

  if (type === "turn.completed") {
    return [
      {
        type: "turn.completed",
        runId: request.runId,
        provider: "codex",
        threadId: currentThreadId,
        usage: mapUsage(event.usage)
      }
    ];
  }

  if (type === "turn.failed") {
    const error = event.error as { message?: string } | undefined;
    return [
      {
        type: "turn.failed",
        runId: request.runId,
        provider: "codex",
        error: error?.message ?? "Codex turn failed"
      }
    ];
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = mapItem(event.item);
    const events: ShellEvent[] = [
      {
        type,
        runId: request.runId,
        provider: "codex",
        item
      }
    ];

    if (type === "item.completed" && item.type === "agent_message" && item.text) {
      events.push({
        type: "agent.delta",
        runId: request.runId,
        provider: "codex",
        text: item.text
      });
    }

    return events;
  }

  return [
    {
      type: "log",
      runId: request.runId,
      level: "info",
      message: `Codex event: ${type || "unknown"}`
    }
  ];
}

function mapItem(rawItem: unknown): AgentItem {
  const item = rawItem as Record<string, unknown> | undefined;
  const itemType = String(item?.type ?? "unknown");
  return {
    id: String(item?.id ?? `${itemType}-${Date.now().toString(36)}`),
    type: itemType,
    status: mapItemStatus(item?.status),
    title: itemType.replaceAll("_", " "),
    text: typeof item?.text === "string" ? item.text : undefined
  };
}

function mapItemStatus(status: unknown): AgentItem["status"] {
  if (status === "in_progress" || status === "inProgress") return "inProgress";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return undefined;
}

function mapUsage(rawUsage: unknown): Usage | null {
  const usage = rawUsage as Record<string, unknown> | undefined;
  if (!usage) return null;
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    cachedInputTokens: Number(usage.cached_input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    reasoningOutputTokens: Number(usage.reasoning_output_tokens ?? 0)
  };
}
