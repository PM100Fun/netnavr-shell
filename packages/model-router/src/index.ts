import type { AgentProvider, RunRequest, ShellEvent } from "@netnavr/shell-protocol";

export interface RoutedAgent {
  readonly provider: AgentProvider;
  run(request: RunRequest, signal?: AbortSignal): AsyncGenerator<ShellEvent>;
}

export class ModelRouter {
  private readonly agents = new Map<AgentProvider, RoutedAgent>();

  register(agent: RoutedAgent): void {
    this.agents.set(agent.provider, agent);
  }

  providers(): AgentProvider[] {
    return [...this.agents.keys()];
  }

  run(request: RunRequest, signal?: AbortSignal): AsyncGenerator<ShellEvent> {
    const agent = this.agents.get(request.provider);
    if (!agent) {
      throw new Error(`Unknown provider: ${request.provider}`);
    }
    return agent.run(request, signal);
  }
}

export class MockAgent implements RoutedAgent {
  readonly provider = "mock" as const;

  async *run(request: RunRequest, signal?: AbortSignal): AsyncGenerator<ShellEvent> {
    const threadId = request.threadId ?? `mock-${Date.now().toString(36)}`;
    yield { type: "thread.started", runId: request.runId, provider: this.provider, threadId };
    yield { type: "turn.started", runId: request.runId, provider: this.provider, threadId };

    const response = [
      "Mock agent online.",
      "",
      "I received:",
      request.prompt.trim() || "(empty prompt)",
      "",
      "Next useful move: wire this same event stream to Codex, then add cheap-model summarizers as routing targets."
    ].join("\n");

    const itemId = `item-${Date.now().toString(36)}`;
    yield {
      type: "item.started",
      runId: request.runId,
      provider: this.provider,
      item: {
        id: itemId,
        type: "agent_message",
        status: "inProgress",
        title: "Mock response"
      }
    };

    for (const token of response.split(/(\s+)/)) {
      if (signal?.aborted) {
        yield { type: "turn.failed", runId: request.runId, provider: this.provider, error: "Cancelled" };
        return;
      }
      yield { type: "agent.delta", runId: request.runId, provider: this.provider, text: token };
      await sleep(18);
    }

    yield {
      type: "item.completed",
      runId: request.runId,
      provider: this.provider,
      item: {
        id: itemId,
        type: "agent_message",
        status: "completed",
        text: response
      }
    };
    yield {
      type: "turn.completed",
      runId: request.runId,
      provider: this.provider,
      threadId,
      usage: {
        inputTokens: request.prompt.length,
        cachedInputTokens: 0,
        outputTokens: response.length,
        reasoningOutputTokens: 0
      }
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
