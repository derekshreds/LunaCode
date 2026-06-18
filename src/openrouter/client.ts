import {
  ChatCompletionRequest,
  ChatMessage,
  StreamEvent,
  ToolDefinition,
  Usage,
} from "./types";

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** "deny" routes only to providers that don't store/train on prompts. */
  dataCollection?: "deny" | "allow";
  /** Enforce Zero Data Retention endpoints only. */
  zdr?: boolean;
}

export interface CompletionParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Thin streaming client for the OpenRouter Chat Completions API.
 *
 * Uses the global fetch (Node 18+/VS Code's runtime) and parses the SSE stream
 * incrementally, normalizing OpenAI-style deltas into discrete StreamEvents so
 * the agent loop can consume text, reasoning, tool calls, and usage uniformly.
 */
export class OpenRouterClient {
  constructor(private opts: OpenRouterClientOptions) {}

  update(opts: Partial<OpenRouterClientOptions>) {
    this.opts = { ...this.opts, ...opts };
  }

  get model(): string {
    return this.opts.model;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "Content-Type": "application/json",
      // Optional attribution headers recommended by OpenRouter.
      "HTTP-Referer": "https://github.com/lunacode",
      "X-Title": "Luna Code (VS Code)",
    };
  }

  /** Stream a chat completion, yielding normalized events. */
  async *stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    const body: ChatCompletionRequest = {
      model: this.opts.model,
      messages: params.messages,
      tools: params.tools,
      tool_choice: params.tools && params.tools.length ? "auto" : undefined,
      temperature: params.temperature ?? 0,
      // Omit when not capped so the provider uses the model's full output limit
      // (prevents write_file truncation on large files).
      max_tokens: params.maxTokens && params.maxTokens > 0 ? params.maxTokens : undefined,
      stream: true,
      usage: { include: true },
      // Privacy routing: only use providers that don't train on/store prompts.
      provider: { data_collection: this.opts.dataCollection ?? "deny" },
      zdr: this.opts.zdr ? true : undefined,
    };

    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
      yield { type: "error", message: `Network error: ${e?.message ?? e}` };
      return;
    }

    if (!res.ok || !res.body) {
      const text = await safeText(res);
      yield {
        type: "error",
        message: `OpenRouter ${res.status}: ${text || res.statusText}`,
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason: string | null = null;

    // Parse a single SSE line into events. `terminal` means stop the stream.
    const handleLine = (
      line: string
    ): { events: StreamEvent[]; terminal: boolean } => {
      const events: StreamEvent[] = [];
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith(":")) return { events, terminal: false };
      if (!trimmed.startsWith("data:")) return { events, terminal: false };
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return { events, terminal: true };
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return { events, terminal: false }; // partial/incomplete frame
      }
      if (json.error) {
        events.push({
          type: "error",
          message: json.error.message ?? JSON.stringify(json.error),
        });
        return { events, terminal: true };
      }
      const choice = json.choices?.[0];
      if (choice) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length) {
          events.push({ type: "text", delta: delta.content });
        }
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length) {
          events.push({ type: "reasoning", delta: reasoning });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            if (tc.id || tc.function?.name) {
              events.push({
                type: "tool_call_start",
                index,
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
              });
            }
            if (typeof tc.function?.arguments === "string" && tc.function.arguments.length) {
              events.push({ type: "tool_call_delta", index, argsDelta: tc.function.arguments });
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (json.usage) events.push({ type: "usage", usage: json.usage as Usage });
      return { events, terminal: false };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIndex: number;
        while ((nlIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIndex);
          buffer = buffer.slice(nlIndex + 1);
          const { events, terminal } = handleLine(line);
          for (const ev of events) yield ev;
          if (terminal) {
            yield { type: "done", finishReason };
            return;
          }
        }
      }
      // Flush any trailing line the server sent without a final newline.
      if (buffer.trim().length) {
        const { events } = handleLine(buffer);
        for (const ev of events) yield ev;
      }
      yield { type: "done", finishReason };
    } catch (e: any) {
      if (e?.name === "AbortError") {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
      yield { type: "error", message: `Stream error: ${e?.message ?? e}` };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  /** Fetch the list of available models from OpenRouter. */
  async listModels(): Promise<
    Array<{ id: string; name: string; contextLength?: number; pricing?: any }>
  > {
    const res = await fetch(`${this.opts.baseUrl}/models`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Failed to list models: ${res.status} ${res.statusText}`);
    }
    const json: any = await res.json();
    return (json.data ?? []).map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length,
      pricing: m.pricing,
    }));
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
