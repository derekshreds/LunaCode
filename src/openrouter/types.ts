// OpenAI-compatible types as accepted by the OpenRouter Chat Completions API,
// extended with the `cache_control` breakpoints OpenRouter forwards to providers
// (Anthropic / Gemini) for prompt caching.

export interface CacheControl {
  type: "ephemeral";
}

export interface TextPart {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
  cache_control?: CacheControl;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded
  };
}

export interface SystemMessage {
  role: "system";
  content: string | ContentPart[];
}

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string | ContentPart[];
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatCompletionRequest {
  model: string;
  /** OpenRouter fallback routing: models tried in order. */
  models?: string[];
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  // OpenRouter passthrough — controls provider usage accounting in stream.
  usage?: { include: boolean };
  // OpenRouter provider routing preferences (e.g. { data_collection: "deny" }).
  provider?: Record<string, unknown>;
  // OpenRouter unified reasoning control (e.g. { effort: "high" } or { enabled: false }).
  reasoning?: Record<string, unknown>;
  // Per-request Zero Data Retention enforcement.
  zdr?: boolean;
  // OpenAI cache-routing key (passed through by OpenRouter). OpenAI's automatic
  // prompt caching routes requests by a hash of the prompt's first ~256 tokens
  // plus this key; newer models (GPT-5.6+) need it for reliable prefix matching.
  prompt_cache_key?: string;
  // OpenRouter sticky-routing key. Without it, sticky routing (same provider
  // endpoint across a conversation, which keeps the provider's prompt cache
  // warm) only activates AFTER a cache hit is observed — a chicken-and-egg
  // problem when hits are what's broken. With it, stickiness starts on the
  // first successful request.
  session_id?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  // OpenRouter / Anthropic cache accounting (present when available).
  prompt_tokens_details?: {
    /** Tokens read from the provider's prompt cache (the discount). */
    cached_tokens?: number;
    /** Tokens written to the provider's prompt cache (billed at >1x on
     * Anthropic and OpenAI GPT-5.6+). write>0 with read=0 call after call
     * means the prefix never matches — each request re-caches from scratch. */
    cache_write_tokens?: number;
  };
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost?: number;
}

// Discriminated events emitted by the streaming client.
export type StreamEvent =
  | { type: "model"; id: string } // served by a fallback model
  // Upstream provider serving this request (e.g. "OpenAI" vs "Azure"). Provider
  // prompt caches are separate, so per-call provider bouncing shows up as a
  // cache-hit-rate collapse — surfacing it makes that diagnosable.
  | { type: "provider"; name: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argsDelta: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string | null }
  // A transient failure is being retried; `attempt` is the attempt that failed.
  | { type: "retry"; attempt: number; maxAttempts: number; reason: string }
  | { type: "error"; message: string; code?: number };
