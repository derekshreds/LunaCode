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
  /** Models to fall back to (OpenRouter `models` routing) when the primary
   * model errors or is unavailable. */
  fallbackModels?: string[];
}

/** Retry transient HTTP failures (429/5xx/network) before the stream starts. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
/** Abort a stream that produces no bytes for this long. */
const STALL_TIMEOUT_MS = 120_000;

/** True when `served` is `configured` or a versioned/variant slug of it
 * (e.g. "vendor/model-20260616" or "vendor/model:free" for "vendor/model"). */
function sameModel(served: string, configured: string): boolean {
  return (
    served === configured ||
    served.startsWith(configured + "-") ||
    served.startsWith(configured + ":") ||
    configured.startsWith(served + "-") ||
    configured.startsWith(served + ":")
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export interface CompletionParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Override the client's configured model for this call (e.g. summarizer). */
  model?: string;
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
    const primary = params.model ?? this.opts.model;
    // OpenRouter fallback routing: try each model in order. Only applied to
    // the main session model — explicit per-call overrides (summarizer,
    // sub-agent) run exactly the model they asked for.
    const fallbacks =
      !params.model && this.opts.fallbackModels?.length
        ? this.opts.fallbackModels.filter((m) => m && m !== primary)
        : [];
    const body: ChatCompletionRequest = {
      model: primary,
      models: fallbacks.length ? [primary, ...fallbacks] : undefined,
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

    // Transient failures BEFORE any bytes stream are safe to retry with
    // backoff (429 / 5xx / network). Mid-stream failures are never retried.
    let res: Response | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
        if (attempt < MAX_ATTEMPTS) {
          try {
            await sleep(RETRY_BASE_MS * attempt, params.signal);
          } catch {
            yield { type: "done", finishReason: "aborted" };
            return;
          }
          continue;
        }
        yield { type: "error", message: `Network error: ${e?.message ?? e}` };
        return;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if ((!res.ok || !res.body) && retryable && attempt < MAX_ATTEMPTS) {
        await safeText(res); // drain
        try {
          await sleep(RETRY_BASE_MS * attempt, params.signal);
        } catch {
          yield { type: "done", finishReason: "aborted" };
          return;
        }
        continue;
      }
      break;
    }
    if (!res || !res.ok || !res.body) {
      const text = res ? await safeText(res) : "";
      yield {
        type: "error",
        message: `OpenRouter ${res?.status ?? "?"}: ${text || res?.statusText || "no response"}`,
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason: string | null = null;
    let servedModel: string | null = null;

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
      // Surface which model actually served the request — ONLY when fallback
      // routing is configured and the served model is one of the fallbacks.
      // Providers report versioned slugs (e.g. "vendor/model-20260616" for
      // "vendor/model"), so a bare string mismatch is NOT a fallback.
      if (
        fallbacks.length &&
        typeof json.model === "string" &&
        json.model &&
        json.model !== servedModel
      ) {
        servedModel = json.model;
        if (!sameModel(json.model, primary) && fallbacks.some((f) => sameModel(json.model, f))) {
          events.push({ type: "model", id: json.model });
        }
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
        // Watchdog: a stream that produces no bytes for STALL_TIMEOUT_MS is
        // treated as hung so the UI never spins forever.
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const stall = new Promise<never>((_, reject) => {
          stallTimer = setTimeout(
            () => reject(new Error(`No data from the provider for ${STALL_TIMEOUT_MS / 1000}s — stream appears hung.`)),
            STALL_TIMEOUT_MS
          );
        });
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await Promise.race([reader.read(), stall]));
        } finally {
          clearTimeout(stallTimer);
        }
        if (done) break;
        if (!value) continue;
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

  /**
   * Run a completion to the end and return the accumulated text. Reuses the
   * SSE path so abort/error semantics match stream(). Never throws — errors
   * are reported via the `error` field.
   */
  async complete(
    params: CompletionParams
  ): Promise<{ text: string; usage?: Usage; error?: string }> {
    let text = "";
    let usage: Usage | undefined;
    let error: string | undefined;
    for await (const ev of this.stream(params)) {
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "usage") usage = ev.usage;
      else if (ev.type === "error") {
        error = ev.message;
        break;
      }
    }
    return { text, usage, error };
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
