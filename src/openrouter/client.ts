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
  /** Rank providers by throughput/latency/price instead of OpenRouter's
   * default load balancing. Throughput/latency cut down upstream idle
   * timeouts from slow providers on big contexts. */
  providerSort?: "throughput" | "latency" | "price";
  /** Restrict routing to providers serving these quantization levels (e.g.
   * ["fp8","fp16","bf16"]). Empty/undefined = no restriction. Use to avoid being
   * routed to low-precision (e.g. fp4) endpoints. */
  quantizations?: string[];
  /** Thinking effort for reasoning-capable models. "off" disables reasoning;
   * low/medium/high map to OpenRouter's unified `reasoning.effort`. Undefined =
   * the model's default. */
  reasoningEffort?: "off" | "low" | "medium" | "high";
  /** Session-stable key for OpenAI's automatic prompt-cache routing. OpenAI
   * routes by prompt-prefix hash + this key, and GPT-5.6+ effectively require
   * it — without one, hit rates collapse to ~0% even with a byte-identical
   * prefix. Only sent on openai/ models; other providers use cache_control. */
  promptCacheKey?: string;
  /** Override the stall watchdog (ms without a data frame); for tests. */
  stallTimeoutMs?: number;
}

/** Retry transient failures: HTTP 429/5xx/network errors before the stream
 * starts, and mid-stream provider stalls before any content has streamed. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
/** Generation records are finalized asynchronously after a stream closes. */
const GENERATION_COST_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000];
/** Abort a stream that produces no DATA frames for this long. Keepalive
 * comments (": OPENROUTER PROCESSING") don't count — OpenRouter keeps
 * sending them while an upstream provider is stalled, so a byte-level
 * watchdog would never fire and the turn would hang forever. */
const STALL_TIMEOUT_MS = 120_000;

/** OpenRouter error-frame codes for transient provider failures (gateway
 * timeouts, overload, rate limits) as opposed to permanent request errors. */
const TRANSIENT_FRAME_CODES = new Set([408, 429, 500, 502, 503, 504, 522, 524]);

/** True when a stream failure is transient (provider-side, worth retrying) —
 * e.g. the 504 "Upstream idle timeout exceeded" OpenRouter emits when a
 * provider goes silent too long (typical during long non-streamed reasoning),
 * overload, rate limits, the stall watchdog, or a dropped connection. */
export function isTransientFrame(message: string, code?: number): boolean {
  if (code !== undefined) return TRANSIENT_FRAME_CODES.has(code);
  return /timeout|timed out|overloaded|unavailable|too many|rate.?limit|try again|appears hung|no data|stall|terminated|socket|econn|network/i.test(
    message
  );
}

/** True when the model's prompt caching is driven by explicit `cache_control`
 * breakpoints that OpenRouter forwards (Anthropic, Gemini via Vertex). Every
 * other provider (OpenAI, Grok, Groq, DeepSeek, …) uses implicit exact-prefix
 * caching, where ANY volatile render-time content — even past the last
 * breakpoint — poisons the cached entry: on OpenAI GPT-5.6+ the automatic
 * cache entry is keyed at the LATEST message and reads require an exact
 * prefix match, so a trailing message that changes every call yields
 * write-everything/read-nothing on every single request. */
export function usesCacheControl(model: string): boolean {
  return model.startsWith("anthropic/") || model.startsWith("google/");
}

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
  /** Per-call reasoning effort override (adaptive routing). */
  reasoningEffort?: "off" | "low" | "medium" | "high";
  /** Tool-choice override. "none" forces a text answer while KEEPING the tool
   * schemas in the request — the serialized prefix stays identical to prior
   * calls, so the prompt cache built during the run still hits. Dropping the
   * tools array instead would change the prefix and full-miss the cache. */
  toolChoice?: "auto" | "none";
}

/**
 * Thin streaming client for the OpenRouter Chat Completions API.
 *
 * Uses the global fetch (Node 18+/VS Code's runtime) and parses the SSE stream
 * incrementally, normalizing OpenAI-style deltas into discrete StreamEvents so
 * the agent loop can consume text, reasoning, tool calls, and usage uniformly.
 */
/** Map the reasoning-effort option to OpenRouter's unified `reasoning` param.
 * Undefined effort → undefined (omitted → the model's own default). */
function reasoningParam(
  effort?: "off" | "low" | "medium" | "high"
): Record<string, unknown> | undefined {
  if (!effort) return undefined;
  return effort === "off" ? { enabled: false } : { effort };
}

export class OpenRouterClient {
  constructor(private opts: OpenRouterClientOptions) {}

  update(opts: Partial<OpenRouterClientOptions>) {
    this.opts = { ...this.opts, ...opts };
  }

  get model(): string {
    return this.opts.model;
  }

  /** Generation id of the most recent stream, for post-hoc cost lookup when a
   * turn was cancelled before the usage frame arrived. */
  private lastGenId: string | null = null;
  get generationId(): string | null {
    return this.lastGenId;
  }

  /** Best-effort actual usage/cost for a generation via OpenRouter's
   * /generation endpoint. Used when a stream was aborted before its usage
   * frame. Retries briefly (the record finalizes shortly after). Null on
   * failure. */
  async fetchGenerationCost(
    id: string
  ): Promise<{ prompt_tokens: number; completion_tokens: number; cost: number; cachedTokens: number } | null> {
    for (const delayMs of GENERATION_COST_RETRY_DELAYS_MS) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      try {
        const res = await fetch(`${this.opts.baseUrl}/generation?id=${encodeURIComponent(id)}`, {
          headers: this.headers(),
        });
        if (res.ok) {
          const d = (await res.json())?.data;
          if (d && d.total_cost != null) {
            return {
              prompt_tokens: Number(d.tokens_prompt ?? d.native_tokens_prompt ?? 0) || 0,
              completion_tokens: Number(d.tokens_completion ?? d.native_tokens_completion ?? 0) || 0,
              cost: Number(d.total_cost) || 0,
              cachedTokens: Number(d.native_tokens_cached ?? 0) || 0,
            };
          }
        }
      } catch {
        /* transient — retry */
      }
    }
    return null;
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
      tool_choice:
        params.tools && params.tools.length ? params.toolChoice ?? "auto" : undefined,
      temperature: params.temperature ?? 0,
      // Omit when not capped so the provider uses the model's full output limit
      // (prevents write_file truncation on large files).
      max_tokens: params.maxTokens && params.maxTokens > 0 ? params.maxTokens : undefined,
      stream: true,
      usage: { include: true },
      // Privacy routing: only use providers that don't train on/store prompts.
      provider: {
        data_collection: this.opts.dataCollection ?? "deny",
        ...(this.opts.providerSort ? { sort: this.opts.providerSort } : {}),
        ...(this.opts.quantizations?.length ? { quantizations: this.opts.quantizations } : {}),
      },
      reasoning: reasoningParam(params.reasoningEffort ?? this.opts.reasoningEffort),
      zdr: this.opts.zdr ? true : undefined,
      prompt_cache_key:
        this.opts.promptCacheKey && primary.startsWith("openai/")
          ? this.opts.promptCacheKey
          : undefined,
      // Sticky routing on ALL models. Without this, OpenRouter only pins the
      // provider endpoint after it OBSERVES a cache hit — so a session whose
      // hits are broken (or whose first requests bounce between e.g.
      // OpenAI/Azure, which keep separate caches) may never converge.
      session_id: this.opts.promptCacheKey || undefined,
    };

    // Failures are retried with backoff while nothing has been committed to
    // the turn: transient HTTP errors (429/5xx/network) before the stream
    // starts, and mid-stream failures — OpenRouter error frames like the 504
    // "Upstream idle timeout exceeded" emitted when a provider goes silent
    // during long reasoning, the stall watchdog, dropped connections — as
    // long as no content has streamed. The caller only commits a turn after
    // a clean stream, so re-issuing the request is state-safe. Streamed
    // reasoning does NOT block a retry (it is never committed to the
    // conversation, and hidden thinking is exactly where providers stall);
    // streamed text, tool calls, or usage do.
    let committed = false;
    let servedModel: string | null = null;
    let servedProvider: string | null = null;
    this.lastGenId = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
        if (attempt >= MAX_ATTEMPTS) {
          yield { type: "error", message: `Network error: ${e?.message ?? e}` };
          return;
        }
        yield {
          type: "retry",
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          reason: `Network error: ${e?.message ?? e}`,
        };
        try {
          await sleep(RETRY_BASE_MS * attempt, params.signal);
        } catch {
          yield { type: "done", finishReason: "aborted" };
          return;
        }
        continue;
      }
      if (!res.ok || !res.body) {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        const text = await safeText(res); // read the error (and drain the body)
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          yield {
            type: "error",
            message: `OpenRouter ${res.status}: ${text || res.statusText || "no response"}`,
          };
          return;
        }
        yield {
          type: "retry",
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          reason: `OpenRouter HTTP ${res.status}`,
        };
        try {
          await sleep(RETRY_BASE_MS * attempt, params.signal);
        } catch {
          yield { type: "done", finishReason: "aborted" };
          return;
        }
        continue;
      }

      // OpenRouter returns this header as soon as the request is accepted.
      // Capture it before reading the body so cancellation can still recover
      // authoritative usage when no SSE chunk (or final usage frame) arrives.
      const headerGenId = res.headers.get("X-Generation-Id");
      if (headerGenId) this.lastGenId = headerGenId;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason: string | null = null;
      // Set when a transient mid-stream failure should re-issue the request
      // instead of surfacing an error.
      let retryReason: string | null = null;

      // Parse a single SSE line into events. `terminal` means stop the stream;
      // `meaningful` marks real data frames (keepalive comments are not) so
      // the stall watchdog only counts genuine provider output.
      const handleLine = (
        line: string
      ): { events: StreamEvent[]; terminal: boolean; meaningful: boolean } => {
        const events: StreamEvent[] = [];
        const trimmed = line.trimEnd();
        if (!trimmed || trimmed.startsWith(":"))
          return { events, terminal: false, meaningful: false };
        if (!trimmed.startsWith("data:"))
          return { events, terminal: false, meaningful: false };
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return { events, terminal: true, meaningful: true };
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          // Partial/incomplete frame — still proof the provider is alive.
          return { events, terminal: false, meaningful: true };
        }
        if (json.error) {
          const code = Number(json.error.code);
          events.push({
            type: "error",
            message: json.error.message ?? JSON.stringify(json.error),
            code: Number.isFinite(code) ? code : undefined,
          });
          return { events, terminal: true, meaningful: true };
        }
        if (typeof json.id === "string" && json.id) this.lastGenId = json.id;
        // Surface the upstream provider (OpenRouter includes it on stream
        // chunks). Providers keep separate prompt caches for the same model,
        // so per-call bouncing (e.g. OpenAI↔Azure) silently kills hit rates.
        if (typeof json.provider === "string" && json.provider && json.provider !== servedProvider) {
          servedProvider = json.provider;
          events.push({ type: "provider", name: json.provider });
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
        return { events, terminal: false, meaningful: true };
      };

      const stallMs = this.opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
      const stallError = () =>
        new Error(`No data from the provider for ${Math.round(stallMs / 1000)}s — stream appears hung.`);
      // Watchdog clock: reset ONLY by data frames. Keepalive comments arrive
      // even while the upstream provider is stalled, so counting raw bytes
      // would let a dead stream spin forever.
      let lastDataAt = Date.now();

      try {
        readLoop: while (true) {
          const remaining = lastDataAt + stallMs - Date.now();
          if (remaining <= 0) throw stallError();
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          const stall = new Promise<never>((_, reject) => {
            stallTimer = setTimeout(() => reject(stallError()), remaining);
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
            const { events, terminal, meaningful } = handleLine(line);
            if (meaningful) lastDataAt = Date.now();
            for (const ev of events) {
              if (
                ev.type === "error" &&
                !committed &&
                attempt < MAX_ATTEMPTS &&
                isTransientFrame(ev.message, ev.code)
              ) {
                retryReason = ev.message;
                break readLoop;
              }
              if (
                ev.type === "text" ||
                ev.type === "tool_call_start" ||
                ev.type === "tool_call_delta" ||
                ev.type === "usage"
              ) {
                committed = true;
              }
              yield ev;
            }
            if (terminal) {
              yield { type: "done", finishReason };
              return;
            }
          }
        }
        if (retryReason === null) {
          // Flush any trailing line the server sent without a final newline.
          if (buffer.trim().length) {
            const { events } = handleLine(buffer);
            for (const ev of events) {
              if (
                ev.type === "error" &&
                !committed &&
                attempt < MAX_ATTEMPTS &&
                isTransientFrame(ev.message, ev.code)
              ) {
                retryReason = ev.message;
                break;
              }
              yield ev;
            }
          }
          if (retryReason === null) {
            yield { type: "done", finishReason };
            return;
          }
        }
      } catch (e: any) {
        if (e?.name === "AbortError") {
          yield { type: "done", finishReason: "aborted" };
          return;
        }
        if (committed || attempt >= MAX_ATTEMPTS) {
          yield { type: "error", message: `Stream error: ${e?.message ?? e}` };
          return;
        }
        // Read failures here are connection-level (stall watchdog, reset
        // socket) — transient by nature, so retry while uncommitted.
        retryReason = `${e?.message ?? e}`;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }

      // Transient mid-stream failure with nothing committed: drop the dead
      // connection, back off, and re-issue the request.
      try {
        await res.body.cancel();
      } catch {
        /* ignore */
      }
      yield {
        type: "retry",
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        reason: retryReason ?? "transient stream failure",
      };
      try {
        await sleep(RETRY_BASE_MS * attempt, params.signal);
      } catch {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
    }
    // Unreachable: the final attempt always returns above.
    yield { type: "error", message: "Retry attempts exhausted." };
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
